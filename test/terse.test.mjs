import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { begin, snapshot, loadRun } from '../dist/project.js';
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

test('M1 rejects corrupted baseline fields with actionable diagnostics', async t => {
  const p = project(t);
  const run = ready(p.root);
  const file = path.join(p.root, '.terse/runs', run, 'baseline.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cases = [
    ['null document', () => null, /BASELINE_INVALID.*document/],
    ['array snapshot', b => { b.snapshot = []; }, /BASELINE_INVALID.*snapshot/],
    ['array sources', b => { b.snapshot.files = []; }, /BASELINE_INVALID.*snapshot.files/],
    ['null source', b => { b.snapshot.files['src/calculate.js'] = null; }, /BASELINE_INVALID.*src\/calculate.js/],
    ['missing metadata', b => { delete b.snapshot.metadata; }, /BASELINE_INVALID.*snapshot.metadata/],
    ['invalid metadata hash', b => { b.snapshot.metadata['package.json'] = 'invalid'; }, /BASELINE_INVALID.*package.json/],
    ['invalid skipped entry', b => { b.snapshot.skipped = [null]; }, /BASELINE_INVALID.*snapshot.skipped/],
    ['unknown skip reason', b => { b.snapshot.skipped = [{ path: 'src/missing.js', reason: 'pretend-scanned' }]; }, /BASELINE_INVALID.*reason/],
    ['overlapping snapshot entries', b => { b.snapshot.skipped.push({ path: 'src/calculate.js', reason: 'excluded' }); }, /BASELINE_INVALID.*multiple snapshot entries/],
    ['missing config field', b => { delete b.snapshot.config.minTokens; }, /BASELINE_INVALID.*minTokens/],
    ['invalid config value', b => { b.snapshot.config.minTokens = 0; }, /BASELINE_INVALID.*minTokens/],
    ['missing verification timeout', b => { delete b.snapshot.config.verification[0].timeoutMs; }, /BASELINE_INVALID.*timeoutMs/],
    ['invalid verification args', b => { b.snapshot.config.verification[0].args = 'not-an-array'; }, /BASELINE_INVALID.*args/],
    ['invalid timestamp', b => { b.createdAt = 'yesterday'; }, /BASELINE_INVALID.*createdAt/],
    ['invalid head', b => { b.head = 42; }, /BASELINE_INVALID.*head/],
    ['source mismatch', b => { b.snapshot.files['src/calculate.js'].content += '\n// altered'; }, /BASELINE_INTEGRITY.*src\/calculate.js/],
    ['removed source with stale hash', b => { delete b.snapshot.files['src/calculate.js']; }, /BASELINE_INTEGRITY.*snapshot.hash/],
    ['metadata changed with stale hash', b => { b.snapshot.metadata['package.json'] = 'a'.repeat(64); }, /BASELINE_INTEGRITY.*snapshot.hash/],
    ['config changed with stale hash', b => { b.snapshot.config.minTokens += 1; }, /BASELINE_INTEGRITY.*snapshot.hash/],
    ['skipped changed with stale hash', b => { b.snapshot.skipped.push({ path: 'extra.txt', reason: 'excluded' }); }, /BASELINE_INTEGRITY.*snapshot.hash/],
    ['incompatible schema', b => { b.schema = 2; }, /BASELINE_INCOMPATIBLE.*schema/],
    ['incompatible analyzer', b => { b.analyzer = 'another-version'; }, /BASELINE_INCOMPATIBLE.*analyzer/],
    ['wrong run', b => { b.run = `1234567890123-${run.slice(14)}`; }, /BASELINE_INCOMPATIBLE.*run/],
    ['wrong repository', b => { b.root = path.join(p.root, 'another'); }, /BASELINE_INCOMPATIBLE.*root/],
  ];
  for (const [name, mutate, expected] of cases) await t.test(name, () => {
    const baseline = structuredClone(original);
    const value = mutate(baseline);
    fs.writeFileSync(file, JSON.stringify(value === undefined ? baseline : value));
    assert.throws(() => loadRun(p.root, run), error => {
      assert.match(error.message, expected);
      assert(error.message.includes(file));
      assert.match(error.message, /terse begin/);
      return true;
    });
  });
});

test('M1 validates relative paths consistently on Windows and Linux', async t => {
  const p = project(t);
  const run = ready(p.root);
  const file = path.join(p.root, '.terse/runs', run, 'baseline.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const invalid of ['../outside.js', 'src/../outside.js', 'C:/outside.js', 'C:outside.js', '/outside.js', 'src\\outside.js', 'src//outside.js', './src/calculate.js']) {
    const changed = structuredClone(original);
    changed.snapshot.files[invalid] = changed.snapshot.files['src/calculate.js'];
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => loadRun(p.root, run), /BASELINE_INVALID.*path/);
  }
  p.write('src/version..backup.js', 'export const backup = 1;');
  const valid = ready(p.root);
  assert(loadRun(p.root, valid).baseline.snapshot.files['src/version..backup.js']);
  assert.equal((await check(p.root, valid)).status, 'pass');
});

test('M1 CLI reports invalid or missing baseline JSON without disclosing file contents', t => {
  const p = project(t);
  const run = ready(p.root);
  const file = path.join(p.root, '.terse/runs', run, 'baseline.json');
  for (const command of ['context', 'check']) {
    for (const missing of [false, true]) {
      fs.writeFileSync(file, '{"secret": "do-not-print-this');
      if (missing) fs.unlinkSync(file);
      const args = [cli, command, '--run', run, '--cwd', p.root, '--json', ...(command === 'context' ? ['--query', 'calculate'] : [])];
      const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(result.status, 3);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, 'incomplete');
      assert.match(report.errors[0], missing ? /JSON_READ_FAILED/ : /INVALID_JSON/);
      assert(report.errors[0].includes(file));
      assert.match(report.errors[0], /terse begin/);
      assert(!result.stdout.includes('do-not-print-this'));
    }
  }
});

test('M1 keeps schema-1 runs usable after JSON key reordering and before any Git commit', async t => {
  const p = project(t, { 'src/calculate.js': body, 'src/other.ts': 'export const other = 1;', 'package.json': '{"private": true}' });
  const run = ready(p.root);
  const file = path.join(p.root, '.terse/runs', run, 'baseline.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.schema, 1);
  assert.equal(saved.head, null);
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value;
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify(reverse(saved), null, 4));
  assert.equal(loadRun(p.root, run).baseline.snapshot.hash, saved.snapshot.hash);
  assert.equal((await check(p.root, run)).status, 'pass');
});

test('M1 refuses invalid baseline before verification executes', async t => {
  const p = project(t, undefined, { verification: [{ command: 'node', args: ['-e', "require('node:fs').writeFileSync('executed.txt', 'yes')"] }] });
  const run = ready(p.root);
  const file = path.join(p.root, '.terse/runs', run, 'baseline.json');
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  baseline.snapshot.hash = '0'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(baseline));
  await assert.rejects(check(p.root, run), /BASELINE_INTEGRITY.*snapshot.hash/);
  assert(!fs.existsSync(path.join(p.root, 'executed.txt')));
  assert(!fs.existsSync(path.join(p.root, '.terse/runs', run, 'report.json')));
});

test('M1 distinguishes missing runs, invalid IDs and non-file baseline records', t => {
  const p = project(t);
  const run = ready(p.root);
  assert.throws(() => loadRun(p.root, `1234567890123-${'-'.repeat(36)}`), /INVALID_RUN_ID/);
  assert.throws(() => loadRun(p.root, `1234567890123-${run.slice(14)}`), /RUN_NOT_FOUND.*terse begin/);
  const file = path.join(p.root, '.terse/runs', run, 'baseline.json');
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => loadRun(p.root, run), /JSON_READ_FAILED.*regular file/);
});
