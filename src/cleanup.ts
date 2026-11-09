import ts from 'typescript';
import { isBuiltin } from 'node:module';
import type { indexSources } from './analyze.js';
import type { Decision, Finding, Snapshot } from './types.js';

type Index = ReturnType<typeof indexSources>;

// Compare indexed identities, not task wording or the chosen strategy. Moving or
// renaming a declaration retires its old path/name even if a new owner exists.
// Exact AST spans collapse nested helpers into their removed parent, including
// declarations that share a line. Coverage loss is not proof of removal.
export function undeclaredRemovals(before: Snapshot, after: Snapshot, oldIndex: Index, current: Index, declared: Decision['remove']): Decision['remove'] {
  const uncovered = new Set(after.skipped.map(item => item.path));
  const targets: Decision['remove'] = Object.keys(before.files).filter(file => !Object.hasOwn(after.files, file) && !uncovered.has(file)).map(path => ({ path }));
  const currentNames = new Set(current.symbols.map(item => JSON.stringify([item.path, item.symbol])));
  const missing = oldIndex.declarations.filter(({ location }) => Object.hasOwn(after.files, location.path)
    && !currentNames.has(JSON.stringify([location.path, location.symbol])));
  for (const declaration of missing) {
    if (missing.some(parent => parent.location.path === declaration.location.path && parent.start < declaration.start && parent.end >= declaration.end)) continue;
    const { path, symbol } = declaration.location;
    if (!targets.some(target => target.path === path && target.symbol === symbol)) targets.push({ path, symbol });
  }
  return targets.filter(target => !declared.some(item => item.path === target.path && (item.symbol === undefined || item.symbol === target.symbol)));
}

// Bind local declarations and export aliases without reading libraries or live files.
function bindings(state: Snapshot) {
  const prefix = '/__terse__/';
  const sources = new Map(Object.entries(state.files).map(([file, source]) => [prefix + file,
    ts.createSourceFile(prefix + file, source.content, ts.ScriptTarget.Latest, true)]));
  const program = ts.createProgram([...sources.keys()], { noLib: true, noResolve: true, allowJs: true, checkJs: true, module: ts.ModuleKind.ESNext }, {
    getSourceFile: file => sources.get(file), getDefaultLibFileName: () => '', writeFile: () => {},
    getCurrentDirectory: () => prefix, getDirectories: () => [], getCanonicalFileName: file => file,
    useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    fileExists: file => sources.has(file), readFile: file => sources.get(file)?.text,
  });
  const checker = program.getTypeChecker();
  const exportsOf = (file: string) => {
    const source = sources.get(prefix + file);
    const module = source && checker.getSymbolAtLocation(source);
    return module ? checker.getExportsOfModule(module).map(symbol => ({ name: symbol.name,
      declarations: ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol).declarations ?? [] })) : [];
  };
  return { source: (file: string) => sources.get(prefix + file), checker, exportsOf };
}

export function cleanupFindings(before: Snapshot, after: Snapshot, oldIndex: Index, current: Index, removals: Decision['remove']): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: string, severity: Finding['severity'], message: string, locations: Finding['locations']) => findings.push({ rule, severity, message, locations });
  const oldBindings = bindings(before);
  const newBindings = bindings(after);
  let checkUnresolved = false;
  for (const target of removals) {
    const symbol = oldIndex.symbols.find(s => s.path === target.path && s.symbol === target.symbol);
    const existed = target.symbol ? !!symbol : Object.hasOwn(before.files, target.path);
    if (!existed) { add('REMOVAL_TARGET_UNKNOWN', 'review', 'Removal target was not present in the scanned baseline.', [target]); continue; }
    const remains = target.symbol ? current.symbols.some(s => s.path === target.path && s.symbol === target.symbol) : Object.hasOwn(after.files, target.path);
    if (remains) { add('REMOVAL_REMAINS', 'fail', 'An implementation declared for removal is still present.', [target]); continue; }
    if (after.skipped.some(s => s.path === target.path)) {
      add('REMOVAL_NOT_VERIFIED', 'review', 'The removal target is outside current source coverage; absence from the index does not prove deletion.', [target]); continue;
    }
    checkUnresolved = true;
    const exportedNames = target.symbol ? oldBindings.exportsOf(target.path).filter(e => e.declarations.some(d =>
      d.getSourceFile() === oldBindings.source(target.path) && (d as ts.NamedDeclaration).name?.getText() === target.symbol
      && d.getSourceFile().getLineAndCharacterOfPosition(d.getStart()).line + 1 === symbol!.line)).map(e => e.name) : [];
    const remainingExports = newBindings.exportsOf(target.path).filter(e => e.declarations.some(d => d.getSourceFile() === newBindings.source(target.path))).map(e => e.name);
    const forwarded = newBindings.source(target.path)?.statements.filter(ts.isExportDeclaration).filter(s => s.moduleSpecifier);
    for (const reference of current.imports.filter(i => i.target === target.path)) {
      const locations = [{ path: reference.from, line: reference.line }, target];
      if (reference.requireCall) {
        add('REMOVAL_REFERENCE_UNCERTAIN', 'review', 'Review require usage; syntax alone cannot establish whether require is locally replaced.', locations); continue;
      }
      if (!target.symbol || !Object.hasOwn(after.files, target.path) || reference.names?.some(n => exportedNames.includes(n) && !remainingExports.includes(n))) {
        const replacement = target.symbol && forwarded?.some(s => !s.exportClause || (ts.isNamedExports(s.exportClause) && s.exportClause.elements.some(e => reference.names?.includes(e.name.text))));
        add(replacement ? 'REMOVAL_REFERENCE_UNCERTAIN' : 'REMOVAL_REFERENCE_REMAINS', replacement ? 'review' : 'fail',
          replacement ? 'A forwarding export may replace the removed symbol; verify the re-export chain.' : `Reference to removed ${target.path}${target.symbol ? `#${target.symbol}` : ''}: ${reference.specifier}`, locations);
      } else if (reference.names === undefined || !exportedNames.length || target.symbol.includes('.')) {
        add('REMOVAL_REFERENCE_UNCERTAIN', 'review', 'Namespace, re-export, require, dynamic import or non-exported member usage requires cleanup review.', locations);
      }
    }
    // Direct calls to a removed top-level declaration; the checker excludes local shadows/replacements.
    if (target.symbol && !target.symbol.includes('.')) {
      const oldSource = oldBindings.source(target.path)!;
      const topLevel = oldSource.statements.some(s => oldSource.getLineAndCharacterOfPosition(s.getStart()).line + 1 === symbol!.line);
      const source = newBindings.source(target.path);
      if (source && topLevel) {
        const visit = (node: ts.Node) => {
          const name = (ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) ? node.expression
            : ts.isExportSpecifier(node) && ts.isExportDeclaration(node.parent.parent) && !node.parent.parent.moduleSpecifier ? node.propertyName ?? node.name : undefined;
          if (name && name.text === target.symbol) {
            const bound = newBindings.checker.getSymbolAtLocation(name);
            const declaration = bound && ((bound.flags & ts.SymbolFlags.Alias) ? newBindings.checker.getAliasedSymbol(bound) : bound);
            const imported = bound?.declarations?.some(d => ts.isImportSpecifier(d) || ts.isImportClause(d));
            if (!imported && !declaration?.declarations?.some(d => d.getSourceFile() === source)) add('REMOVAL_REFERENCE_REMAINS', 'fail', `Unbound local reference to removed ${target.symbol}.`,
              [{ path: target.path, line: source.getLineAndCharacterOfPosition(name.getStart()).line + 1, symbol: target.symbol }]);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
      if (source && !topLevel) add('REMOVAL_REFERENCE_UNCERTAIN', 'review', 'References to a removed nested declaration require scope-aware cleanup review.', [target]);
    } else if (target.symbol && Object.hasOwn(after.files, target.path)) {
      add('REMOVAL_REFERENCE_UNCERTAIN', 'review', 'Member removal requires reviewing instance and computed property accesses.', [target]);
    }
  }
  if (checkUnresolved) {
    const unresolved = current.imports.filter(i => !i.target && (i.reason === 'dynamic-expression'
      || (!isBuiltin(i.specifier) && (i.requireCall || !i.externalDependency))));
    if (unresolved.length) add('REMOVAL_REFERENCE_UNRESOLVED', 'review', 'Some imports have uncertain ownership; review local paths, aliases, undeclared packages, require calls and dynamic expressions before accepting cleanup.',
      unresolved.map(i => ({ path: i.from, line: i.line })));
  }
  return findings;
}
