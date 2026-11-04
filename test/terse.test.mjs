import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { begin, snapshot } from '../dist/project.js';
import { context } from '../dist/analyze.js';
import { check } from '../dist/check.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const body = `export function calculate(items) {
  const valid = items.filter(item => item.enabled);
  const rows = valid.map(item => {
    if (!Number.isFinite(item.amount)) throw new Error('invalid amount');
    const value = item.amount * item.quantity;
    return { id: item.id, value, label: String(item.name).trim() };
  });
  return rows.sort((left, right) => left.value - right.value);
}
`;

function project(t, files = { 'src/calculate.js': body }, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-test-'));
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [name, content] of Object.entries(files)) write(name, content);
  write('terse.config.json', JSON.stringify({ verification: [{ command: 'node', args: ['-e', 'process.exit(0)'] }], ...config }));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root: fs.realpathSync(root), write };
}

function ready(root, { symbol = 'calculate', file = 'src/calculate.js', remove = [] } = {}) {
  const run = begin(root, 'Modify existing behavior');
  context(root, run.run, symbol, 5);
  fs.writeFileSync(run.decisionPath, JSON.stringify({ strategy: 'modify', rationale: 'The existing function owns this behavior.',
    considered: [{ path: file, symbol, disposition: 'modify', reason: 'Preserve the existing entry point.' }], remove }));
  return run.run;
}

test('baseline captures dirty/staged/untracked content, excludes generated files, and ignores its own cache', t => {
  const p = project(t);
  execFileSync('git', ['add', 'src/calculate.js'], { cwd: p.root });
  p.write('src/calculate.js', `${body}\n// unstaged user edit\n`);
  p.write('src/untracked.ts', 'export const existingUserWork = 1;');
  p.write('dist/output.js', body);
  p.write('node_modules/pkg/index.js', body);
  const run = ready(p.root);
  const baseline = JSON.parse(fs.readFileSync(path.join(p.root, '.terse/runs', run, 'baseline.json')));
  assert.match(baseline.snapshot.files['src/calculate.js'].content, /unstaged user edit/);
  assert(baseline.snapshot.files['src/untracked.ts']);
  assert.equal(Object.keys(baseline.snapshot.files).length, 2);
  assert.equal(snapshot(p.root).hash, baseline.snapshot.hash);
});

test('context finds TS/JS/JSX/TSX symbols, relative importers and Chinese comments', t => {
  const p = project(t, {
    'src/calculate.ts': '// 金额计算\n' + body.replace('(items)', '(items: any[])'),
    'src/consumer.js': "import { calculate } from './calculate.js';\nexport const run = () => calculate([]);",
    'src/View.tsx': 'export const View = () => <div>view</div>;',
    'src/Other.jsx': 'export function Other() { return <span>other</span>; }',
    'test/calculate.test.mjs': "import { calculate } from '../src/calculate.ts'; calculate([]);",
  });
  const b = begin(p.root, '金额计算');
  const result = context(p.root, b.run, '金额计算 calculate View Other', 10);
  assert.equal(result.errors.length, 0);
  const found = result.candidates.find(c => c.symbol === 'calculate');
  assert(found.importedBy.some(i => i.from === 'src/consumer.js'));
  assert(found.relatedTests.includes('test/calculate.test.mjs'));
  assert(result.candidates.some(c => c.symbol === 'View'));
  assert(result.candidates.some(c => c.symbol === 'Other'));
  assert.equal(context(p.root, b.run, 'notPresentAnywhereXYZ', 5).candidates.length, 0);
});

test('new copy is reported, existing clone remains baseline, and identical movement is not new', async t => {
  const p = project(t, { 'src/calculate.js': body, 'src/old.js': body.replace('calculate', 'previous') });
  const run = ready(p.root);
  const unchanged = await check(p.root, run);
  assert(unchanged.baselineClones > 0);
  assert.equal(unchanged.newDuplications, 0);
  assert.equal(unchanged.status, 'pass');
  fs.renameSync(path.join(p.root, 'src/old.js'), path.join(p.root, 'src/moved.js'));
  p.write('src/moved.js', '\n// new comment\n' + body.replace('calculate', 'previous'));
  assert.equal((await check(p.root, run)).newDuplications, 0);
  p.write('src/new.js', body.replace('calculate', 'another'));
  const report = await check(p.root, run);
  assert.equal(report.status, 'needs-review');
  assert(report.newDuplications > 0);
  assert(report.findings.some(f => f.rule === 'NEW_DUPLICATION' && f.locations.length === 2));
});

test('checks duplicates between two newly added files', async t => {
  const p = project(t, { 'src/calculate.js': 'export function calculate() { return 1; }' });
  const run = ready(p.root);
  p.write('src/one.js', body.replace('calculate', 'one'));
  p.write('src/two.js', body.replace('calculate', 'two'));
  assert((await check(p.root, run)).newDuplications > 0);
});

test('original function modification preserves a passing report', async t => {
  const p = project(t);
  const run = ready(p.root);
  p.write('src/calculate.js', body.replace('item.enabled', 'item.enabled && item.quantity > 0'));
  const result = await check(p.root, run);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.changes.modified, ['src/calculate.js']);
});

test('missing workflow records and missing verification are never reported as pass', async t => {
  const p = project(t, undefined, { verification: [] });
  const b = begin(p.root, 'Change behavior');
  const result = await check(p.root, b.run);
  assert.equal(result.status, 'needs-review');
  for (const rule of ['CONTEXT_MISSING', 'DECISION_MISSING', 'VERIFICATION_MISSING']) assert(result.findings.some(f => f.rule === rule));
});

test('retrieval recorded only after edits does not satisfy baseline evidence', async t => {
  const p = project(t);
  const b = begin(p.root, 'Change behavior');
  p.write('src/calculate.js', body.replace('item.enabled', '!item.disabled'));
  context(p.root, b.run, 'calculate', 5);
  assert((await check(p.root, b.run)).findings.some(f => f.rule === 'CONTEXT_MISSING'));
});

test('declared removal is checked against baseline and current symbols', async t => {
  const p = project(t, { 'src/calculate.js': body + '\nexport function obsolete() { return 7; }' });
  const run = ready(p.root, { remove: [{ path: 'src/calculate.js', symbol: 'obsolete' }] });
  const before = await check(p.root, run);
  assert.equal(before.status, 'fail');
  assert(before.findings.some(f => f.rule === 'REMOVAL_REMAINS'));
  p.write('src/calculate.js', body);
  assert.equal((await check(p.root, run)).status, 'pass');
});

test('new strict-policy duplication fails even when verification passes', async t => {
  const p = project(t, undefined, { duplicatePolicy: 'fail' });
  const run = ready(p.root);
  p.write('src/copy.js', body.replace('calculate', 'copy'));
  const result = await check(p.root, run);
  assert.equal(result.status, 'fail');
  assert.equal(result.verification[0].status, 'passed');
});

test('a policy change cannot quietly weaken the check or execute newly supplied commands', async t => {
  const p = project(t);
  const run = ready(p.root);
  p.write('terse.config.json', JSON.stringify({ minTokens: 1000, verification: [{ command: 'node', args: ['-e', "require('node:fs').writeFileSync('should-not-exist', 'bad')"] }] }));
  const result = await check(p.root, run);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.verification.length, 0);
  assert(!fs.existsSync(path.join(p.root, 'should-not-exist')));
});

test('parse errors produce incomplete with file location and scanned count', async t => {
  const p = project(t);
  const run = ready(p.root);
  p.write('src/broken.ts', 'export function broken( {');
  const result = await check(p.root, run);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.scannedFiles, 2);
  assert(result.errors.some(e => e.includes('src/broken.ts:')));
});

test('verification failures, launch errors and timeouts have distinct outcomes', async t => {
  for (const [command, expected] of [
    [{ command: 'node', args: ['-e', 'process.exit(5)'] }, 'fail'],
    [{ command: 'terse-nonexistent-executable', args: [] }, 'incomplete'],
    [{ command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 150 }, 'incomplete'],
  ]) {
    const p = project(t, undefined, { verification: [command] });
    assert.equal((await check(p.root, ready(p.root))).status, expected);
  }
});

test('verification that changes source invalidates the report', async t => {
  const p = project(t, undefined, { verification: [{ command: 'node', args: ['-e', "require('node:fs').appendFileSync('src/calculate.js', '\\n// concurrent edit')"] }] });
  const result = await check(p.root, ready(p.root));
  assert.equal(result.status, 'incomplete');
  assert(result.errors.some(e => e.includes('changed during check')));
});

test('explicitly skipped checks need review, even when configured', async t => {
  const p = project(t);
  const result = await check(p.root, ready(p.root), true);
  assert.equal(result.status, 'needs-review');
  assert.equal(result.verification.length, 0);
});

test('unreadable source coverage is visible instead of a false pass', async t => {
  const p = project(t);
  const run = ready(p.root);
  p.write('src/large.js', ' '.repeat(1024 * 1024 + 1));
  const result = await check(p.root, run);
  assert.equal(result.status, 'needs-review');
  assert(result.skipped.some(s => s.path === 'src/large.js' && s.reason === 'over-1MiB'));
});

test('CLI JSON, argument validation, corrupted baseline and exit codes are usable by agents', t => {
  const p = project(t);
  const invoke = args => {
    const result = spawnSync(process.execPath, [cli, ...args, '--cwd', p.root, '--json'], { encoding: 'utf8' });
    return { code: result.status, json: JSON.parse(result.stdout) };
  };
  const b = invoke(['begin', '--task', 'CLI task']);
  assert.equal(b.code, 0);
  assert.equal(invoke(['check', '--run', b.json.run]).code, 2);
  assert.equal(invoke(['context', '--run', b.json.run, '--query', 'calculate']).code, 0);
  assert.equal(invoke(['context', '--run', b.json.run, '--query', 'calculate', '--limit', 'NaN']).code, 3);
  assert.equal(invoke(['check', '--run', '../escape']).code, 3);
  assert.equal(invoke(['begin', '--task', 'x', '--skip-verification']).code, 3);
  fs.writeFileSync(path.join(p.root, '.terse/runs', b.json.run, 'baseline.json'), '{}');
  assert.equal(invoke(['check', '--run', b.json.run]).json.status, 'incomplete');
});

test('example comparison runs all three commands and identical acceptance tests', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/demo.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const summary = JSON.parse(result.stdout);
  const [copy, reuse] = summary.results;
  assert.equal(copy.status, 'needs-review');
  assert(copy.newDuplications > 0);
  assert.equal(reuse.status, 'pass');
  assert.equal(reuse.newDuplications, 0);
  assert.deepEqual(copy.verification, ['passed']);
  assert.deepEqual(reuse.verification, ['passed']);
});
