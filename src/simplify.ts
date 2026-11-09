import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';
import {candidateId, indexSources} from './analyze.js';
import {check} from './check.js';
import {decide} from './decision.js';
import {digest, loadRun, snapshot, writeJson} from './project.js';

function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), {code});
}

export function sourceMetrics(content: string, filename = 'source.ts') {
  const ast = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
  let tokens = 0;
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (ts.isToken(node)) {
      if (node.kind > ts.SyntaxKind.LastTriviaToken && node.kind !== ts.SyntaxKind.EndOfFileToken) tokens++;
    } else node.getChildren(ast).forEach(visit);
  };
  visit(ast);
  return {bytes: Buffer.byteLength(content), nonBlankLines: content.split(/\r?\n/).filter(line => line.trim()).length, tokens};
}

// A small executable refactor, not a semantic-similarity auto-merger. Keep both
// function declarations/public contracts; replace only one exact duplicate body.
export async function simplify(root: string, run: string, candidate: string, into: string, apply = false) {
  const {baseline, dir} = loadRun(root, run);
  const oldIndex = indexSources(baseline.snapshot);
  if (oldIndex.errors.length) reject('SIMPLIFY_ANALYSIS', oldIndex.errors.join('; '));
  const selected = [candidate, into].map(id => {
    const symbol = oldIndex.symbols.find(item => candidateId(item, baseline.snapshot.files[item.path].hash) === id);
    if (!symbol) reject('SIMPLIFY_CANDIDATE', `Unknown baseline candidate: ${id}`);
    return symbol;
  });
  const [target, canonical] = selected;
  if (candidate === into || target.path !== canonical.path) reject('SIMPLIFY_SCOPE', 'Choose two different functions in the same source file.');
  const current = snapshot(root);
  if (JSON.stringify(current.config) !== JSON.stringify(baseline.snapshot.config)) reject('SIMPLIFY_POLICY', 'Project policy changed; review it before beginning a new task.');
  if (current.skipped.some(item => !['excluded', 'unsupported-or-declaration'].includes(item.reason))) reject('SIMPLIFY_COVERAGE', 'Resolve source coverage gaps before automatic simplification.');
  const index = indexSources(current, root, baseline.snapshot.files);
  if (index.errors.length) reject('SIMPLIFY_ANALYSIS', index.errors.join('; '));
  const source = current.files[target.path];
  if (!source) reject('SIMPLIFY_STALE', 'The selected source is no longer scanned.');
  const ast = ts.createSourceFile(target.path, source.content, ts.ScriptTarget.Latest, true);
  if (!ts.isExternalModule(ast)) reject('SIMPLIFY_UNSUPPORTED', 'Automatic delegation requires a module, not script-global functions.');
  const oldAst = ts.createSourceFile(target.path, baseline.snapshot.files[target.path].content, ts.ScriptTarget.Latest, true);
  const locate = (file: ts.SourceFile, symbol: string) => {
    const nodes = file.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === symbol);
    if (nodes.length !== 1 || !nodes[0].body) reject('SIMPLIFY_UNSUPPORTED', `Expected one top-level implemented function: ${symbol}`);
    return nodes[0] as ts.FunctionDeclaration & {body: ts.Block; name: ts.Identifier};
  };
  const [from, keep] = selected.map(item => {
    const node = locate(ast, item.symbol), old = locate(oldAst, item.symbol);
    if (node.getText(ast) !== old.getText(oldAst)) reject('SIMPLIFY_STALE', `Candidate changed since begin: ${item.symbol}`);
    if (oldIndex.symbols.filter(symbol => symbol.path === item.path && symbol.symbol === item.symbol).length !== 1) reject('SIMPLIFY_UNSUPPORTED', 'Ambiguous indexed function names require an agent-authored refactor.');
    if (node.asteriskToken || node.typeParameters?.length || ts.isTypePredicateNode(node.type ?? node)
      || ts.getModifiers(node)?.some(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword)
      || node.parameters.some(parameter => !ts.isIdentifier(parameter.name) || parameter.name.text === 'this' || parameter.initializer || parameter.dotDotDotToken || ts.getModifiers(parameter)?.length)) {
      reject('SIMPLIFY_UNSUPPORTED', 'Use ordinary functions with simple parameters, without defaults, rest, generics, predicates or special modifiers.');
    }
    return node;
  });
  if (from.parameters.map(node => node.getText(ast)).join(',') !== keep.parameters.map(node => node.getText(ast)).join(',')
    || from.type?.getText(ast) !== keep.type?.getText(ast) || from.body.getText(ast) !== keep.body.getText(ast)) {
    reject('SIMPLIFY_NOT_IDENTICAL', 'This refactor requires identical parameter declarations, return annotations and body source. Similarity alone cannot authorize merging.');
  }
  const names = new Set([from.name.text, keep.name.text]);
  if (from.parameters.some(parameter => ts.isIdentifier(parameter.name) && names.has(parameter.name.text))) reject('SIMPLIFY_UNSUPPORTED', 'A parameter shadows the selected implementation.');
  const includesName = (node: ts.Node): boolean => (ts.isIdentifier(node) && names.has(node.text)) || !!ts.forEachChild(node, includesName);
  const inspectBody = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword || ts.isMetaProperty(node) || ts.isTaggedTemplateExpression(node)
      || (ts.isIdentifier(node) && (names.has(node.text) || node.text === 'arguments'))
      || (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression))) {
      reject('SIMPLIFY_UNSUPPORTED', 'Context-sensitive, self-referential or directive-bearing bodies require an agent-authored refactor.');
    }
    ts.forEachChild(node, inspectBody);
  };
  inspectBody(from.body);
  const inspectModule = (node: ts.Node) => {
    if ((ts.isIdentifier(node) && node.text === 'eval')
      || (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && includesName(node.left))
      || ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && includesName(node.operand))
      || ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && includesName(node.initializer))) {
      reject('SIMPLIFY_UNSUPPORTED', 'Dynamic evaluation or writes to selected bindings prevent automatic delegation.');
    }
    ts.forEachChild(node, inspectModule);
  };
  inspectModule(ast);
  const replacement = `{ return ${keep.name.getText(ast)}(${from.parameters.map(parameter => parameter.name.getText(ast)).join(', ')}); }`;
  const start = from.body.getStart(ast), end = from.body.end;
  const content = source.content.slice(0, start) + replacement + source.content.slice(end);
  const before = sourceMetrics(source.content, target.path), after = sourceMetrics(content, target.path);
  if (after.tokens >= before.tokens || after.bytes >= before.bytes) reject('SIMPLIFY_NO_REDUCTION', 'Delegation would not reduce both source bytes and non-trivia tokens.');
  const matchingBodies = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.body?.getText(ast) === from.body.getText(ast)).length;
  const plan = {path: target.path, target: target.symbol, into: canonical.symbol, beforeHash: source.hash, afterHash: digest(content),
    edit: {start, end, before: from.body.getText(ast), after: replacement},
    metrics: {before, after, removedBytes: before.bytes - after.bytes, removedTokens: before.tokens - after.tokens,
      matchingBodiesBefore: matchingBodies, matchingBodiesAfter: matchingBodies - 1}};
  const limitations = ['Exact same-file body delegation only; both public entries remain. No general semantic merging or whole-project redundancy guarantee.',
    'Configured verification is evidence within its coverage, not a proof of all behavior. Function source text, stack traces and timing may change.'];
  if (!apply) return {run, status: 'needs-review' as const, applied: false, simplificationVerified: false, plan, limitations,
    next: 'Review this edit and retain the public contracts. Record both candidates with decide, then repeat simplify with --apply to edit and run every configured check.'};
  if (!baseline.snapshot.config.verification.length) reject('SIMPLIFY_VERIFICATION', 'Configure real project verification before begin; automatic edits cannot skip verification.');
  // Reuse all decision/context validation rather than maintaining another validator.
  const {decision} = decide(root, run, {input: path.join(dir, 'decision.json')});
  if (!['modify', 'refactor'].includes(decision.strategy) || selected.some(item => !decision.considered.some(entry =>
    entry.path === item.path && entry.symbol === item.symbol && ['reuse', 'modify'].includes(entry.disposition)))) {
    reject('SIMPLIFY_DECISION', 'Record modify/refactor with both selected candidates accepted before applying.');
  }
  let file = root;
  for (const part of target.path.split('/')) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink()) reject('SIMPLIFY_PATH', 'Refusing a symbolic source path.');
  }
  const original = fs.readFileSync(file);
  if (snapshot(root).hash !== current.hash || digest(new TextDecoder('utf-8', {fatal: true}).decode(original)) !== source.hash) reject('SIMPLIFY_STALE', 'Workspace changed during planning; no source was written.');
  // Snapshot hashes use decoded source (without a UTF-8 BOM). Preserve the raw
  // encoding marker, and compare raw bytes again before replacing the file.
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const encoded = original.subarray(0, 3).equals(bom) ? Buffer.concat([bom, Buffer.from(content)]) : Buffer.from(content);
  // Save the reviewable receipt before the write. Never silently undo user or
  // verifier edits after a failing check; retain the actual patch for correction.
  writeJson(dir, 'simplification.json', {run, applied: false, simplificationVerified: false, plan, limitations});
  const temporary = path.join(dir, `simplification-${randomUUID()}.tmp`);
  try {
    const mode = fs.statSync(file).mode;
    fs.writeFileSync(temporary, encoded, {flag: 'wx', mode});
    fs.chmodSync(temporary, mode);
    if (snapshot(root).hash !== current.hash || !fs.readFileSync(file).equals(original)) reject('SIMPLIFY_STALE', 'Workspace changed before applying; no source was written.');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  writeJson(dir, 'simplification.json', {run, applied: true, simplificationVerified: false, plan, limitations});
  const report = await check(root, run);
  const final = snapshot(root), errors = [...report.errors];
  if (final.hash !== report.snapshotHash || final.files[target.path]?.hash !== plan.afterHash) errors.push('Workspace changed or the simplification was replaced; reduction is not verified.');
  const status = errors.length ? 'incomplete' as const : report.status;
  const simplificationVerified = status === 'pass';
  const result = {run, status, errors, applied: true, simplificationVerified, plan, limitations, report,
    receiptPath: path.join(dir, 'simplification.json'), reportPath: path.join(dir, 'report.json')};
  writeJson(dir, 'simplification.json', result);
  return result;
}
