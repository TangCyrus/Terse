import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { digest } from './project.js';
import type { Snapshot } from './types.js';

export interface ImportReference {
  from: string; specifier: string; line: number; target?: string; config?: string;
  names?: string[]; requireCall?: boolean; targetSnapshot?: 'current' | 'baseline';
  reason?: 'dynamic-expression' | 'config-error' | 'not-found-in-snapshot' | 'outside-source-snapshot';
  externalDependency?: { package: string; manifest: string };
}

// The resolver sees snapshot paths only. Historical indexes never read live config.
export function importResolver(state: Snapshot, errors: string[], root?: string, fallbackFiles: Snapshot['files'] = {}) {
  const base = (root ?? path.resolve('/__terse_snapshot__')).replaceAll('\\', '/');
  const relative = (file: string) => path.relative(base, file).replaceAll('\\', '/');
  const known = new Set([...Object.keys(state.files), ...Object.keys(state.metadata), ...state.skipped.map(s => s.path)]);
  const contents = new Map<string, string | undefined>();
  const host: ts.ModuleResolutionHost = {
    fileExists: file => known.has(relative(file)),
    readFile(file) {
      const name = relative(file);
      if (state.files[name]) return state.files[name].content;
      if (!root || !Object.hasOwn(state.metadata, name)) return undefined;
      if (contents.has(name)) return contents.get(name);
      contents.set(name, undefined);
      try {
        let current = base;
        for (const part of name.split('/')) {
          current = path.join(current, part);
          if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symbolic link');
        }
        if (fs.statSync(file).size > 1024 * 1024) throw new Error('over 1 MiB');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
        if (digest(text) !== state.metadata[name]) throw new Error('changed since snapshot');
        contents.set(name, text);
        return text;
      } catch (error) {
        errors.push(`IMPORT_METADATA: ${name}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },
  };
  // Only source existence falls back. Config and package metadata always belong to state.
  const fallbackHost: ts.ModuleResolutionHost = {
    ...host,
    fileExists: file => host.fileExists(file) || Object.hasOwn(fallbackFiles, relative(file)),
  };
  const packages = new Map<string, Record<string, unknown> | undefined>();
  const packageFiles = [...known].filter(name => /(?:^|\/)package\.json$/.test(name));
  const readPackage = (name: string) => {
    if (!packages.has(name)) {
      const text = host.readFile(path.posix.join(base, name));
      let value;
      try { value = text === undefined ? undefined : JSON.parse(text.replace(/^\uFEFF/, '')); } catch { /* Keep unresolved when package metadata is invalid. */ }
      packages.set(name, value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
    }
    return packages.get(name);
  };
  const externalDependency = (specifier: string, file: string, options: ts.CompilerOptions): ImportReference['externalDependency'] => {
    // A declaration is evidence of external ownership, not proof that a package is installed.
    if (!root || options.baseUrl || Object.keys(options.paths ?? {}).some(pattern => {
      const star = pattern.indexOf('*');
      return star < 0 ? pattern === specifier : specifier.length >= pattern.length - 1
        && specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
    })) return;
    const match = /^(@[a-z0-9_~-][a-z0-9._~-]*\/[a-z0-9_~-][a-z0-9._~-]*|[a-z0-9_~-][a-z0-9._~-]*)(?:\/(.+))?$/i.exec(specifier);
    if (!match || /[\\:%?#]/.test(specifier) || match[2]?.split('/').some(part => !part || part === '.' || part === '..')) return;
    const name = match[1];
    let manifest: string | undefined;
    let directory = path.posix.dirname(file);
    while (true) {
      const candidate = path.posix.join(directory, 'package.json');
      if (known.has(candidate)) { manifest = candidate; break; }
      if (directory === '.') return;
      directory = path.posix.dirname(directory);
    }
    const owner = readPackage(manifest);
    if (!owner) return;
    const declarations = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .map(key => owner[key]).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
    const versions = declarations.filter(value => Object.hasOwn(value, name)).map(value => value[name]);
    // Registry ranges/tags only. File, link, workspace, catalog, npm aliases and URL specs stay uncertain.
    if (!versions.length || versions.some(value => typeof value !== 'string' || !value.trim() || /^\./.test(value.trim()) || /[:/\\]/.test(value))) return;
    // Local packages can use ordinary version ranges too; do not infer external ownership in a workspace.
    for (const candidate of packageFiles) {
      const local = readPackage(candidate);
      if (!local || local.name === name || Object.hasOwn(local, 'workspaces')) return;
    }
    return { package: name, manifest };
  };
  const configs = new Map<string, { options: ts.CompilerOptions; invalid: boolean }>();
  return (file: string, ast: ts.SourceFile) => {
    let config: string | undefined;
    if (root) {
      let directory = path.posix.dirname(file);
      while (true) {
        config = ['tsconfig.json', 'jsconfig.json'].map(n => path.posix.join(directory, n)).find(n => known.has(n));
        if (config || directory === '.') break;
        directory = path.posix.dirname(directory);
      }
    }
    let settings = configs.get(config ?? '');
    if (!settings) {
      let invalid = false;
      const report = (d: ts.Diagnostic) => {
        // File inclusion is owned by Terse, not the compiler project.
        if (d.code === 18002 || d.code === 18003) return;
        invalid = true;
        errors.push(`IMPORT_CONFIG: ${config}: TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
      };
      const parsed = config ? ts.getParsedCommandLineOfConfigFile(path.posix.join(base, config), {}, {
        ...host, useCaseSensitiveFileNames: true, readDirectory: () => [],
        getCurrentDirectory: () => base, onUnRecoverableConfigFileDiagnostic: report,
      }) : undefined;
      parsed?.errors.forEach(report);
      settings = { options: { ...(parsed?.options.module === undefined ? { moduleResolution: ts.ModuleResolutionKind.Node10 } : {}), ...parsed?.options }, invalid: invalid || (!!config && !parsed) };
      configs.set(config ?? '', settings);
    }
    const { options, invalid } = settings;
    const containingFile = path.posix.join(base, file);
    ast.impliedNodeFormat = ts.getImpliedNodeFormatForFile(containingFile, undefined, host, options);
    return (expression: ts.Expression): Pick<ImportReference, 'specifier' | 'target' | 'reason' | 'config' | 'targetSnapshot' | 'externalDependency'> => {
      const literal = ts.isStringLiteralLike(expression);
      const specifier = literal ? expression.text : expression.getText(ast);
      if (!literal) return { specifier, config, reason: 'dynamic-expression' };
      if (invalid) return { specifier, config, reason: 'config-error' };
      const mode = ts.getModeForUsageLocation(ast, expression, options);
      const resolve = (resolutionHost: ts.ModuleResolutionHost) => ts.resolveModuleName(specifier, containingFile, options, resolutionHost, undefined, undefined, mode).resolvedModule;
      const current = resolve(host);
      const resolved = current ?? resolve(fallbackHost);
      if (!resolved) {
        const dependency = externalDependency(specifier, file, options);
        return { specifier, config, reason: 'not-found-in-snapshot', ...(dependency ? {externalDependency: dependency} : {}) };
      }
      const target = relative(resolved.resolvedFileName);
      if (Object.hasOwn(state.files, target)) return { specifier, config, target, targetSnapshot: 'current' };
      if (!current && Object.hasOwn(fallbackFiles, target)) return { specifier, config, target, targetSnapshot: 'baseline' };
      return { specifier, config, reason: 'outside-source-snapshot' };
    };
  };
}
