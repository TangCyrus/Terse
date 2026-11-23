import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {invoke, createWorkspace, repository} from '../scripts/lib/workspace.mjs';
import {clones, indexSources, newClones} from '../dist/analyze.js';
import {parseConfig, snapshot} from '../dist/project.js';
import {LEGACY_ANALYZER} from '../dist/types.js';

function example(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-python-'));
  t.after(() => {
    const resolved = fs.realpathSync(temp);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-python-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const root = createWorkspace(temp, 'project', repository, 'python');
  const write = (name, content) => fs.writeFileSync(path.join(root, name), content);
  write('terse.config.json', JSON.stringify({minTokens: 20, minLines: 4}));
  return {root, write};
}

test('Python and JS/TS are scanned together and Python candidates can be selected before editing', t => {
  const {root, write} = example(t);
  write('types.pyi', 'def stub(): ...\n');
  write('bridge.ts', 'export function bridge(): number { return 1; }\n');
  write('bridge.js', 'import { bridge } from "./bridge.ts"; export function call() { return bridge(); }\n');
  write('service.py', [
    'class Receipt:', '    @staticmethod', '    async def total(value: int) -> int:',
    '        def normalize(value):', '            return max(0, value)', '        return normalize(value)',
    '"""def imaginary(): pass"""', '# class Fake:', '',
  ].join('\r\n'));
  write('test_service.py', 'from service import Receipt\nasync def unit():\n    assert await Receipt.total(1) == 1\n');
  const begin = invoke(root, ['begin', '--task', 'Extend receipt formatting', '--query', 'Receipt total bridge format_receipt', '--limit', '20']);
  assert(begin.skipped.some(item => item.path === 'types.pyi'));
  const candidates = begin.context.candidates;
  const total = candidates.find(item => item.symbol === 'Receipt.total');
  assert.equal(total.line, 2);
  assert.equal(total.endLine, 6);
  assert.equal(total.signature, 'async def total(value: int) -> int');
  assert.match(total.snippet, /^@staticmethod/);
  assert.deepEqual(total.relatedTests, ['test_service.py']);
  assert(candidates.some(item => item.symbol === 'Receipt.total.normalize'));
  assert(candidates.some(item => item.symbol === 'Receipt'));
  assert(candidates.some(item => item.path === 'bridge.ts' && item.symbol === 'bridge'));
  assert(!indexSources(snapshot(root)).symbols.some(item => ['imaginary', 'Fake'].includes(item.symbol)));
  assert(indexSources(snapshot(root), root).imports.some(item => item.from === 'bridge.js' && item.target === 'bridge.ts'));
  const saved = invoke(root, ['decide', '--run', begin.run, '--strategy', 'modify', '--candidate', total.candidateId,
    '--rationale', 'Extend the existing receipt owner.']);
  assert.equal(saved.decision.considered[0].symbol, 'Receipt.total');

  const second = candidates.find(item => item.symbol === 'Receipt.total.normalize');
  const unsupported = invoke(root, ['simplify', '--run', begin.run, '--candidate', second.candidateId, '--into', total.candidateId, '--apply'], 3);
  assert.equal(unsupported.diagnostics[0].causeCode, 'SIMPLIFY_UNSUPPORTED');
  assert.equal(snapshot(root).hash, begin.snapshotHash);
});

test('Python increments suppress existing copies, attribute added copies and ignore format-only edits', async t => {
  const {root, write} = example(t);
  const content = fs.readFileSync(path.join(root, 'receipts.py'), 'utf8').replaceAll('\r\n', '\n');
  write('archive.py', content.replace('format_receipt', 'format_archive'));
  const before = snapshot(root);
  assert((await clones(before)).length > 0);
  assert.deepEqual(newClones(before, before, await clones(before)), []);
  write('archive.py', content.replace('format_receipt', 'format_archive').replace('    total = 0', '    # retained copy\n    total=0'));
  const formatted = snapshot(root);
  assert.deepEqual(newClones(before, formatted, await clones(formatted)), []);

  write('paid.py', content.replace('format_receipt', 'format_paid'));
  const typescript = fs.readFileSync(path.join(repository, 'examples/orders/src/orders.ts'), 'utf8');
  write('ledger.ts', typescript);
  write('ledger-copy.ts', typescript);
  const after = snapshot(root);
  const increments = newClones(before, after, await clones(after));
  assert(increments.some(({attribution, locations}) => attribution.kind === 'additional-copy'
    && attribution.baselineOccurrences === 2 && attribution.currentOccurrences === 3
    && locations.some(item => item.path === 'paid.py' && item.line >= 1 && item.endLine <= 12)));
  assert(increments.some(({locations}) => locations.some(item => item.path === 'ledger.ts')
    && locations.some(item => item.path === 'ledger-copy.ts')));
  assert(increments.every(({locations}) => new Set(locations.map(item => path.extname(item.path))).size === 1));
});

test('Python token equality preserves indentation, statement boundaries and string contents', async () => {
  const source = (name, block) => ({hash: name, content: `def ${name}(value):\n${block}\n`});
  const original = source('old', ['    if value:', '        record("a  b")', '        append(value)', '        finalize(value)'].join('\n'));
  const state = files => ({files, config: parseConfig({minTokens: 12, minLines: 4}), skipped: [], metadata: {}});
  const compare = candidate => clones(state({'a.py': original, 'b.py': source('new', candidate)}));
  const body = original.content.slice(original.content.indexOf('\n') + 1).trimEnd();
  assert((await compare(body)).length > 0);
  assert.deepEqual(await compare(body.replace('        append', '    append').replace('        finalize', '    finalize')), []);
  assert.deepEqual(await compare(body.replace('a  b', 'a b')), []);
  assert.deepEqual(await compare(body.replace('append(value)', 'append(value); finalize(value)').replace('\n        finalize(value)', '')), []);
});

test('Python syntax errors are visible in context and stop check before configured verification', t => {
  const {root, write} = example(t);
  write('terse.config.json', JSON.stringify({verification: [{command: 'node', args: ['-e', 'process.exit(0)']}]}));
  const task = invoke(root, ['begin', '--task', 'Inspect a receipt', '--query', 'format_receipt']);
  write('broken.py', 'def bad(:\n    return 1\n');
  const retrieval = invoke(root, ['context', '--run', task.run, '--query', 'bad'], 3);
  assert.match(retrieval.errors.join('\n'), /broken\.py:1:\d+: Python syntax/);
  const report = invoke(root, ['check', '--run', task.run], 3);
  assert.equal(report.status, 'incomplete');
  assert.match(report.errors.join('\n'), /Current analysis error: broken\.py/);
  assert.deepEqual(report.verification, []);
});

test('declared Python removals still require manual reference review after deletion', t => {
  const {root, write} = example(t);
  write('legacy.py', 'def retired():\n    return 1\n');
  write('terse.config.json', JSON.stringify({verification: [{command: 'node', args: ['-e', 'process.exit(0)']}]}));
  const task = invoke(root, ['begin', '--task', 'Retire the old Python module', '--query', 'format_receipt']);
  const retained = task.context.candidates.find(item => item.symbol === 'format_receipt');
  invoke(root, ['decide', '--run', task.run, '--strategy', 'refactor', '--candidate', retained.candidateId,
    '--remove', 'legacy.py', '--rationale', 'Keep one receipt module.']);
  const present = invoke(root, ['check', '--run', task.run], 1);
  assert(present.findings.some(item => item.rule === 'REMOVAL_REMAINS'));
  fs.unlinkSync(path.join(root, 'legacy.py'));
  const removed = invoke(root, ['check', '--run', task.run], 2);
  assert.deepEqual(removed.changes.deleted, ['legacy.py']);
  assert(removed.findings.some(item => item.rule === 'REMOVAL_REFERENCE_UNCERTAIN' && item.locations[0].path === 'legacy.py'));
  assert.equal(removed.verification[0].status, 'passed');
});

test('pre-Python baselines keep their original file coverage when reopened', t => {
  const {root, write} = example(t);
  write('app.ts', 'export function render() { return "receipt"; }\n');
  const task = invoke(root, ['begin', '--task', 'Legacy JS/TS work']);
  const file = path.join(path.dirname(task.decisionPath), 'baseline.json');
  const legacy = snapshot(root, false);
  fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file, 'utf8')), analyzer: LEGACY_ANALYZER, snapshot: legacy}));
  const retrieval = invoke(root, ['context', '--run', task.run, '--query', 'render format_receipt']);
  assert.equal(retrieval.snapshotHash, legacy.hash);
  assert.equal(retrieval.scannedFiles, 1);
  assert.deepEqual(retrieval.candidates.map(item => item.symbol), ['render']);
});
