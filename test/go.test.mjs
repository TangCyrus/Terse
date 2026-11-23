import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWorkspace, invoke, repository} from '../scripts/lib/workspace.mjs';
import {clones, newClones} from '../dist/analyze.js';
import {goSyntax} from '../dist/go.js';
import {parseConfig, snapshot} from '../dist/project.js';
import {PYTHON_ANALYZER} from '../dist/types.js';

function example(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-go-'));
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-go-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const root = createWorkspace(parent, 'project', repository, 'go');
  const write = (file, content) => fs.writeFileSync(path.join(root, file), content);
  write('terse.config.json', JSON.stringify({minLines: 4, minTokens: 24}));
  return {root, write};
}

test('retrieval supports Go functions, generic receiver methods, types and package bindings alongside JS/TS and Python', t => {
  const {root, write} = example(t);
  write('handler.ts', 'export function handler() { return 1; }');
  write('client.js', 'import { handler } from "./handler.ts"; export const call = () => handler();');
  write('calculate.py', 'def calculate():\n    return 1\n');
  write('entry.go', [
    'package receipts', '// 名称 😀', 'type Store[T any] struct { Value T }', 'type Reader interface { Read() int }',
    'type Alias = string', 'const (', '    BatchSize, Limit = 4, 5', ')', 'var First, Second int',
    'func (s *Store[T]) Save(value T) T {', '    const Local = true', '    _ = Local', '    s.Value = value', '    return s.Value', '}',
    'func (Store[T]) Get() int { return 2 }', 'func Identity[T any](value T) T { return value }', '',
  ].join('\r\n'));
  const begin = invoke(root, ['begin', '--task', 'Reuse the receipt formatter', '--query', 'FormatReceipt Store Save Get Reader Alias BatchSize Limit First Second Local Identity handler calculate', '--limit', '20']);
  const candidates = begin.context.candidates;
  const save = candidates.find(candidate => candidate.symbol === 'Store.Save');
  assert.equal(save.line, 10);
  assert.equal(save.endLine, 15);
  assert.equal(save.signature, 'func (s *Store[T]) Save(value T) T');
  for (const symbol of ['Store', 'Store.Get', 'Reader', 'Alias', 'BatchSize', 'Limit', 'First', 'Second', 'Identity', 'handler', 'calculate']) {
    assert(candidates.some(candidate => candidate.symbol === symbol), symbol);
  }
  assert(!candidates.some(candidate => candidate.symbol === 'Local'));
  assert.deepEqual(candidates.find(candidate => candidate.symbol === 'FormatReceipt').relatedTests, ['receipts_test.go']);
  assert(candidates.find(candidate => candidate.symbol === 'handler').importedBy.some(reference => reference.from === 'client.js'));
  const decision = invoke(root, ['decide', '--run', begin.run, '--strategy', 'modify', '--candidate', save.candidateId, '--rationale', 'Reuse Store.Save']);
  assert.equal(decision.decision.considered[0].symbol, 'Store.Save');
  const get = candidates.find(candidate => candidate.symbol === 'Store.Get');
  const simplify = invoke(root, ['simplify', '--run', begin.run, '--candidate', get.candidateId, '--into', save.candidateId, '--apply'], 3);
  assert.equal(simplify.diagnostics[0].causeCode, 'SIMPLIFY_UNSUPPORTED');
  assert.equal(snapshot(root).hash, begin.snapshotHash);
});

test('Go duplicates use baseline occurrences even after comments, line endings and explicit separators change', async t => {
  const {root, write} = example(t);
  const code = fs.readFileSync(path.join(root, 'receipts.go'), 'utf8').replaceAll('\r\n', '\n');
  const copy = name => 'package receipts\nimport ("fmt"; "strings")\n' + code.slice(code.indexOf('func FormatReceipt')).replace('FormatReceipt', name);
  write('archive.go', copy('FormatArchive'));
  const before = snapshot(root);
  assert((await clones(before)).some(item => item.locations.some(location => location.path === 'archive.go')));
  write('archive.go', copy('FormatArchive').replace('total := 0', 'total := 0; // initial total').replaceAll('\n', '\r\n'));
  const formatted = snapshot(root);
  assert.deepEqual(newClones(before, formatted, await clones(formatted)), []);

  write('paid.go', copy('FormatPaid'));
  const typescript = fs.readFileSync(path.join(repository, 'examples/orders/src/orders.ts'), 'utf8');
  write('ledger.ts', typescript);
  write('ledger-copy.ts', typescript);
  const python = fs.readFileSync(path.join(repository, 'examples/python/receipts.py'), 'utf8');
  write('ledger.py', python);
  write('ledger_copy.py', python);
  const after = snapshot(root);
  const increments = newClones(before, after, await clones(after));
  const extra = increments.find(item => item.attribution.kind === 'additional-copy' && item.locations.some(location => location.path === 'paid.go'));
  assert.equal(extra.attribution.baselineOccurrences, 2);
  assert.equal(extra.attribution.currentOccurrences, 3);
  assert(extra.locations.every(location => location.line > 0 && location.endLine > location.line));
  for (const extension of ['.go', '.ts', '.py']) {
    assert(increments.some(item => item.locations.length >= 2 && item.locations.every(location => path.extname(location.path) === extension)));
  }
});

test('Go duplicate streams separate implicit statement boundaries and retain string and rune literals', async () => {
  const source = (name, expression, message) => ({hash: name, content: [
    'package p', `func ${name}(n int) int {`, '    log(n)', '    keep(2)',
    `    return ${expression}`, `    record(\`${message}\`, 'λ')`, '}', '',
  ].join('\n')});
  const left = source('first', '+n', 'a  b');
  const config = parseConfig({minLines: 4, minTokens: 22});
  const compare = right => clones({files: {'a.go': left, 'b.go': right}, config, skipped: [], metadata: {}});
  assert((await compare(source('second', '+n', 'a  b'))).length > 0);
  assert.deepEqual(await compare(source('second', '\n+n', 'a  b')), []);
  assert.deepEqual(await compare(source('second', '+n', 'a b')), []);
  const tokens = goSyntax('a.go', left).tokens;
  assert(tokens.some(token => token.value === "'λ'"));
  assert(tokens.some(token => token.value === '`a  b`'));
});

test('ordinary assignments, if initializers and multi-line literals parse without hiding later syntax errors', t => {
  const {root, write} = example(t);
  write('notes.go', 'package receipts\nconst ReceiptNote = `first\n  second`\n');
  const task = invoke(root, ['begin', '--task', 'Inspect receipts', '--query', 'TestPaidReceiptFiltersAndValidates ReceiptNote']);
  assert(task.context.candidates.some(item => item.symbol === 'TestPaidReceiptFiltersAndValidates'));
  assert(task.context.candidates.some(item => item.symbol === 'ReceiptNote' && item.snippet.includes('  second')));
  write('broken.go', 'package receipts\nfunc broken( {\n');
  const found = invoke(root, ['context', '--run', task.run, '--query', 'broken'], 3);
  assert.match(found.errors.join('\n'), /broken\.go:2:\d+: Go syntax/);
  const result = invoke(root, ['check', '--run', task.run], 3);
  assert.match(result.errors.join('\n'), /Current analysis error: broken\.go/);
});

test('Go removals retain the existing declaration requirement and require reference review', t => {
  const {root, write} = example(t);
  write('legacy.go', 'package receipts\nfunc Legacy() {}\n');
  const task = invoke(root, ['begin', '--task', 'Retire the legacy formatter', '--query', 'FormatReceipt']);
  const selected = task.context.candidates.find(item => item.symbol === 'FormatReceipt');
  const decision = ['decide', '--run', task.run, '--strategy', 'refactor', '--candidate', selected.candidateId,
    '--rationale', 'Retire the old entry point.'];
  invoke(root, decision);
  fs.unlinkSync(path.join(root, 'legacy.go'));
  const omitted = invoke(root, ['check', '--run', task.run], 1);
  assert.deepEqual(omitted.undeclaredRemovals, [{path: 'legacy.go'}]);
  invoke(root, [...decision, '--remove', 'legacy.go']);
  const reviewed = invoke(root, ['check', '--run', task.run], 2);
  assert.deepEqual(reviewed.undeclaredRemovals, []);
  assert(reviewed.findings.some(item => item.rule === 'REMOVAL_REFERENCE_UNCERTAIN'
    && item.message.startsWith('Go references') && item.locations[0].path === 'legacy.go'));
});

test('reopening a Python-era run keeps Go outside its saved baseline', t => {
  const {root, write} = example(t);
  write('calculate.py', 'def calculate():\n    return 1\n');
  const task = invoke(root, ['begin', '--task', 'Existing Python task']);
  const file = path.join(path.dirname(task.decisionPath), 'baseline.json');
  const legacy = snapshot(root, PYTHON_ANALYZER);
  fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file, 'utf8')), analyzer: PYTHON_ANALYZER, snapshot: legacy}));
  const found = invoke(root, ['context', '--run', task.run, '--query', 'calculate FormatReceipt']);
  assert.equal(found.snapshotHash, legacy.hash);
  assert.deepEqual(found.candidates.map(item => item.symbol), ['calculate']);
});
