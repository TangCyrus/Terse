import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { Detector, MemoryStore, weak, type IClone, type IMapFrame } from '@jscpd/core';
import { Tokenizer, tokenize } from '@jscpd/tokenizer';
import { digest, loadRun, readJson, snapshot, writeJson } from './project.js';
import type { DuplicationAttribution, Snapshot, SymbolInfo } from './types.js';
import { importResolver, type ImportReference } from './imports.js';

export function indexSources(state: Snapshot, root?: string, fallbackFiles: Snapshot['files'] = {}) {
  const symbols: SymbolInfo[] = [];
  const imports: ImportReference[] = [];
  const errors: string[] = [];
  const resolver = importResolver(state, errors, root, fallbackFiles);
  for (const [file, source] of Object.entries(state.files)) {
    const ast = ts.createSourceFile(file, source.content, ts.ScriptTarget.Latest, true);
    const resolve = resolver(file, ast);
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
        imports.push({ from: file, ...resolve(expression), names,
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
  const index = indexSources(state, root);
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
  if (snapshot(root).hash !== state.hash) index.errors.push('Project changed during context; run context again on a stable workspace.');
  const result = { command: 'context', run, query, snapshotHash: state.hash, scannedFiles: Object.keys(state.files).length,
    candidates, fileMatches, unresolvedImports: index.imports.filter(i => !i.target), errors: index.errors,
    limitations: ['Lexical ranking and syntactic symbols only; no semantic equivalence or complete call graph.',
      'Imports use the nearest tsconfig.json/jsconfig.json and snapshot files only; dynamic expressions and targets outside source coverage remain unresolved.',
      'Config inheritance is limited to snapshotted tsconfig*.json/jsconfig.json; project references and bundler-specific aliases are not followed.',
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
  tokens: string[];
  locations: { path: string; line: number; endLine: number }[];
}

const tokenKey = (token: ReturnType<typeof tokenize>[number]) => JSON.stringify([token.format, token.type, token.value]);
const sourceTokens = (state: Snapshot) => Object.entries(state.files).map(([file, source]) => ({
  file, tokens: tokenize(source.content, formatOf(file)).filter(weak),
}));

export async function clones(state: Snapshot): Promise<Clone[]> {
  const store = new MemoryStore<IMapFrame>();
  const detector = new Detector(new Tokenizer(), store, [], {
    minTokens: state.config.minTokens, minLines: state.config.minLines, mode: weak,
  });
  const found: IClone[] = [];
  try {
    for (const [file, source] of Object.entries(state.files)) found.push(...await detector.detect(file, source.content, formatOf(file)));
  } finally { store.close(); }
  const tokensByFile = new Map(sourceTokens(state).map(s => [s.file, s.tokens]));
  return found.flatMap(clone => {
    // Preserve lexical context: re-tokenizing a sliced expression can change token types.
    const parts = [clone.duplicationA, clone.duplicationB];
    const sides = parts.map(part => tokensByFile.get(part.sourceId)!.filter(t => t.range[0] >= part.range[0] && t.range[1] <= part.range[1]));
    // jscpd frame ranges can include the first token past a matching window.
    let length = Math.min(...sides.map(s => s.length));
    while (length && tokenKey(sides[0][length - 1]) !== tokenKey(sides[1][length - 1])) length--;
    const tokens = sides[0].slice(0, length).map(tokenKey);
    if (tokens.some((key, i) => key !== tokenKey(sides[1][i]))) throw new Error('Clone token ranges disagree');
    if (length < state.config.minTokens || sides.some(s => s[length - 1].loc!.end.line - s[0].loc!.start.line < state.config.minLines)) return [];
    return [{ fingerprint: digest(JSON.stringify(tokens)), tokens,
      locations: parts.map((part, i) => ({ path: part.sourceId, line: sides[i][0].loc!.start.line, endLine: sides[i][length - 1].loc!.end.line })) }];
  });
}

export function newClones(before: Snapshot, after: Snapshot, current: Clone[]): (Clone & { attribution: DuplicationAttribution })[] {
  const streams = [before, after].map(state => sourceTokens(state).map(s => s.tokens.map(tokenKey)));
  const groups = new Map<string, Clone>();
  for (const clone of current) {
    const group = groups.get(clone.fingerprint);
    if (!group) groups.set(clone.fingerprint, { ...clone, locations: [...clone.locations] });
    else for (const location of clone.locations) {
      if (!group.locations.some(l => l.path === location.path && l.line === location.line && l.endLine === location.endLine)) group.locations.push(location);
    }
  }
  return [...groups.values()].flatMap(clone => {
    const pattern = clone.tokens;
    if (!pattern.length) throw new Error('Empty clone token sequence');
    // KMP counts exact occurrences in linear time per stream, including overlaps.
    const prefix = new Array<number>(pattern.length).fill(0);
    for (let i = 1, j = 0; i < pattern.length; i++) {
      while (j && pattern[i] !== pattern[j]) j = prefix[j - 1];
      if (pattern[i] === pattern[j]) j++;
      prefix[i] = j;
    }
    const [baselineOccurrences, currentOccurrences] = streams.map(files => {
      let count = 0;
      for (const tokens of files) {
        let j = 0;
        for (const token of tokens) {
          while (j && token !== pattern[j]) j = prefix[j - 1];
          if (token === pattern[j]) j++;
          if (j === pattern.length) { count++; j = prefix[j - 1]; }
        }
      }
      return count;
    });
    if (currentOccurrences < 2) throw new Error('Clone evidence does not match source token occurrences');
    if (currentOccurrences <= baselineOccurrences) return [];
    const files = [...new Set(clone.locations.map(l => l.path))].sort().map(file => ({ path: file,
      change: !Object.hasOwn(before.files, file) ? 'added' as const : before.files[file].hash === after.files[file].hash ? 'unchanged' as const : 'modified' as const }));
    return [{ ...clone, attribution: { kind: baselineOccurrences >= 2 ? 'additional-copy' as const : 'new-or-expanded' as const,
      baselineOccurrences, currentOccurrences, files } }];
  });
}
