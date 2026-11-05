import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { Detector, MemoryStore, weak, type IClone, type IMapFrame } from '@jscpd/core';
import { Tokenizer, tokenize } from '@jscpd/tokenizer';
import { digest, loadRun, readJson, snapshot, writeJson } from './project.js';
import type { Snapshot, SymbolInfo } from './types.js';

export function indexSources(state: Snapshot, fallbackFiles: Snapshot['files'] = {}) {
  const symbols: SymbolInfo[] = [];
  const imports: { from: string; specifier: string; target?: string; line: number; names?: string[]; dynamic?: boolean; requireCall?: boolean }[] = [];
  const errors: string[] = [];
  for (const [file, source] of Object.entries(state.files)) {
    const ast = ts.createSourceFile(file, source.content, ts.ScriptTarget.Latest, true);
    const diagnostics = (ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    for (const d of diagnostics) errors.push(`${file}:${ast.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    function visit(node: ts.Node) {
      let name: string | undefined;
      let body: ts.Node | undefined;
      if (ts.isFunctionDeclaration(node) && node.name) { name = node.name.text; body = node.body; }
      else if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        name = node.name.getText(ast); body = node.initializer.body;
      } else if (ts.isMethodDeclaration(node) && node.body) {
        const parent = ts.isClassDeclaration(node.parent) ? node.parent.name?.text : undefined;
        name = `${parent ? `${parent}.` : ''}${node.name.getText(ast)}`; body = node.body;
      } else if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) name = node.name.text;
      if (name) {
        const start = node.getStart(ast);
        symbols.push({ path: file, symbol: name, line: ast.getLineAndCharacterOfPosition(start).line + 1,
          endLine: ast.getLineAndCharacterOfPosition(node.end).line + 1,
          signature: source.content.slice(start, body?.getStart(ast) ?? Math.min(node.end, start + 200)).trim(),
          text: source.content.slice(node.getFullStart(), node.end).trim() });
      }
      let expression: ts.Expression | undefined;
      let names: string[] | undefined;
      if (ts.isImportDeclaration(node)) {
        expression = node.moduleSpecifier;
        const clause = node.importClause;
        if (!clause) names = [];
        else if (!clause.namedBindings || ts.isNamedImports(clause.namedBindings)) names = [
          ...(clause.name ? ['default'] : []),
          ...(clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.map(e => (e.propertyName ?? e.name).text) : []),
        ];
      }
      if (ts.isExportDeclaration(node)) {
        expression = node.moduleSpecifier;
        if (node.exportClause && ts.isNamedExports(node.exportClause)) names = node.exportClause.elements.map(e => (e.propertyName ?? e.name).text);
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) expression = node.moduleReference.expression;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) expression = node.argument.literal;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require')) expression = node.arguments[0];
      if (expression) {
        const dynamic = !ts.isStringLiteralLike(expression);
        const specifier = ts.isStringLiteralLike(expression) ? expression.text : expression.getText(ast);
        let target: string | undefined;
        if (!dynamic && specifier.startsWith('.')) {
          const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
          const stem = base.replace(/\.[cm]?jsx?$/, '');
          const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'].flatMap(ext => [`${base}${ext}`, `${stem}${ext}`, `${base}/index${ext}`])];
          target = candidates.find(p => Object.hasOwn(state.files, p)) ?? candidates.find(p => Object.hasOwn(fallbackFiles, p));
        }
        imports.push({ from: file, specifier, target, names, dynamic,
          requireCall: ts.isCallExpression(node) && node.expression.getText(ast) === 'require',
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return { symbols, imports, errors };
}

function words(query: string): string[] {
  const split = query.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const parts = split.match(/[a-z_$][a-z0-9_$]*|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(parts.flatMap(p => /\p{Script=Han}/u.test(p) && p.length > 2
    ? [p, ...Array.from({ length: p.length - 1 }, (_, i) => p.slice(i, i + 2))] : [p]))];
}

export function context(root: string, run: string, query: string, limit: number) {
  const { dir, baseline } = loadRun(root, run);
  const state = snapshot(root);
  const index = indexSources(state);
  const terms = words(query);
  const candidates = index.symbols.map(symbol => {
    const name = symbol.symbol.toLowerCase();
    const filename = symbol.path.toLowerCase();
    const text = symbol.text.toLowerCase();
    const matched = terms.filter(t => name.includes(t) || filename.includes(t) || text.includes(t));
    const score = matched.reduce((total, t) => total + (name.includes(t) ? 8 : 0) + (filename.includes(t) ? 3 : 0) + (text.includes(t) ? 1 : 0), 0);
    return { ...symbol, score, matched };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line).slice(0, limit).map(({ text, ...symbol }) => ({
    ...symbol, sourceHash: state.files[symbol.path].hash,
    snippet: text.split(/\r?\n/).slice(0, 60).join('\n').slice(0, 6000),
    snippetTruncated: text.split(/\r?\n/).length > 60 || text.length > 6000,
    imports: index.imports.filter(i => i.from === symbol.path),
    importedBy: index.imports.filter(i => i.target === symbol.path),
    relatedTests: Object.keys(state.files).filter(p => /(?:test|spec)[/.]|\.(?:test|spec)\./i.test(p) && state.files[p].content.includes(symbol.symbol.split('.').at(-1)!)),
  }));
  const fileMatches = Object.entries(state.files).filter(([p, s]) => terms.some(t => `${p}\n${s.content}`.toLowerCase().includes(t))).slice(0, limit).map(([p, s]) => ({ path: p, sourceHash: s.hash }));
  const result = { command: 'context', run, query, snapshotHash: state.hash, scannedFiles: Object.keys(state.files).length,
    candidates, fileMatches, errors: index.errors,
    limitations: ['Lexical ranking and syntactic symbols only; no semantic equivalence or complete call graph.',
      'Imports resolve relative paths only; aliases, external packages and dynamic expressions remain unresolved.',
      'Chinese queries match Chinese source comments/names; add English behavior or symbol names when needed.'],
  };
  const evidencePath = path.join(dir, 'context.json');
  const history: unknown[] = fs.existsSync(evidencePath) ? readJson(evidencePath) : [];
  if (!Array.isArray(history)) throw new Error('Invalid context evidence');
  history.push({ query, at: new Date().toISOString(), snapshotHash: state.hash, atBaseline: state.hash === baseline.snapshot.hash,
    candidates: candidates.map(c => ({ path: c.path, symbol: c.symbol, sourceHash: c.sourceHash })), errors: index.errors });
  writeJson(dir, 'context.json', history);
  return result;
}

function formatOf(file: string): string {
  if (/\.tsx$/i.test(file)) return 'tsx';
  if (/\.jsx$/i.test(file)) return 'jsx';
  return /\.[cm]?ts$/i.test(file) ? 'typescript' : 'javascript';
}

export interface Clone {
  fingerprint: string;
  locations: { path: string; line: number; endLine: number }[];
}

export async function clones(state: Snapshot): Promise<Clone[]> {
  const store = new MemoryStore<IMapFrame>();
  const detector = new Detector(new Tokenizer(), store, [], {
    minTokens: state.config.minTokens, minLines: state.config.minLines, mode: weak,
  });
  const found: IClone[] = [];
  try {
    for (const [file, source] of Object.entries(state.files)) found.push(...await detector.detect(file, source.content, formatOf(file)));
  } finally { store.close(); }
  return found.map(clone => {
    const a = clone.duplicationA;
    const text = state.files[a.sourceId].content.slice(...a.range);
    const canonical = tokenize(text, clone.format).filter(weak).map(t => [t.type, t.value]);
    return { fingerprint: digest(JSON.stringify([clone.format, canonical])),
      locations: [a, clone.duplicationB].map(part => ({ path: part.sourceId, line: part.start.line, endLine: part.end.line })) };
  });
}

export function newClones(before: Clone[], after: Clone[]): Clone[] {
  const counts = new Map<string, number>();
  for (const clone of before) counts.set(clone.fingerprint, (counts.get(clone.fingerprint) ?? 0) + 1);
  return after.filter(clone => {
    const remaining = counts.get(clone.fingerprint) ?? 0;
    if (remaining) { counts.set(clone.fingerprint, remaining - 1); return false; }
    return true;
  });
}
