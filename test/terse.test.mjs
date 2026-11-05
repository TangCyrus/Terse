import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { begin, snapshot, loadRun, rootOf } from '../dist/project.js';
import { context, indexSources } from '../dist/analyze.js';
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
  // Windows runners may use an 8.3 TEMP path; use the same Git root as the CLI.
  return { root: rootOf(root), write };
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

test('context resolves aliases, fallback targets and re-exports through inherited config', t => {
  const p = project(t, {
    'config/tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@lib/*': ['missing/*', 'src/lib/*'], exact: ['src/lib/calculate'] } } }),
    'tsconfig.json': '{ "extends": "./config/tsconfig.base.json", /* JSONC */ }',
    'src/lib/calculate.ts': body.replace('(items)', '(items: any[])'),
    'src/consumer.ts': `import { calculate } from '@lib/calculate';
export { calculate } from 'exact';
const lazy = () => import('@lib/calculate');
const common = require('exact');
import legacy = require('exact');
type Shape = typeof import('exact');
export const consumer = () => calculate([]);`,
  });
  const b = begin(p.root, 'reuse calculate');
  const result = context(p.root, b.run, 'calculate', 10);
  assert.deepEqual(result.errors, []);
  const target = result.candidates.find(c => c.symbol === 'calculate');
  assert.equal(target.importedBy.length, 6);
  assert(target.importedBy.every(i => i.target === 'src/lib/calculate.ts' && i.config === 'tsconfig.json'));
  assert.deepEqual(result.unresolvedImports, []);
});

test('nearest jsconfig and tsconfig aliases stay isolated and work without baseUrl', t => {
  const p = project(t, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { shared: ['./root.ts'] } } }),
    'root.ts': 'export const calculate = () => 1;',
    'consumer.ts': "import { calculate } from 'shared'; export const rootConsumer = () => calculate();",
    'nested/jsconfig.json': JSON.stringify({ compilerOptions: { paths: { shared: ['./local.js'] } } }),
    'nested/local.js': 'export const local = () => 2;',
    'nested/consumer.js': "export { local } from 'shared';",
    'nested/deeper/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '../..' } }),
    'nested/deeper/consumer.ts': "export { calculate } from 'root';",
  });
  const result = context(p.root, begin(p.root, 'reuse').run, 'calculate local', 10);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.candidates.find(c => c.symbol === 'local').importedBy.map(i => i.from), ['nested/consumer.js']);
  assert.deepEqual(result.candidates.find(c => c.symbol === 'calculate').importedBy.map(i => i.from), ['consumer.ts', 'nested/deeper/consumer.ts']);
});

test('unresolved imports remain visible even with no matching symbols', t => {
  const p = project(t, {
    'src/consumer.ts': "import './missing'; import 'node:fs'; import './hidden'; import(name); require(`./${name}`);",
    'src/hidden.ts': 'export const hidden = 1;',
  }, { exclude: ['src/hidden.ts'] });
  const b = begin(p.root, 'reuse');
  const result = context(p.root, b.run, 'noSymbol', 5);
  assert.deepEqual(result.errors, []);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.unresolvedImports.length, 5);
  assert.equal(result.unresolvedImports.filter(i => i.reason === 'dynamic-expression').length, 2);
  assert.equal(result.unresolvedImports.find(i => i.specifier === './hidden').reason, 'outside-source-snapshot');
  assert(result.unresolvedImports.every(i => !i.target && i.from === 'src/consumer.ts' && i.line === 1));
});

test('invalid and unsupported config inheritance cannot produce successful context evidence', async t => {
  for (const config of ['{bad', '{"extends":"./tsconfig.missing.json"}', '{"extends":"./tsconfig.json"}', '{"extends":"./base.json"}', '{"compilerOptions":{"paths":12}}']) {
    await t.test(config, async t => {
      const p = project(t, { 'src/calculate.js': body, 'tsconfig.json': config, 'base.json': '{}' });
      const run = ready(p.root);
      const result = context(p.root, run, 'calculate', 5);
      assert(result.errors.some(e => e.startsWith('IMPORT_CONFIG:')));
      assert((await check(p.root, run)).findings.some(f => f.rule === 'CONTEXT_MISSING'));
      const cliResult = spawnSync(process.execPath, [cli, 'context', '--cwd', p.root, '--run', run, '--query', 'calculate', '--json'], { encoding: 'utf8' });
      assert.equal(cliResult.status, 3);
      assert(JSON.parse(cliResult.stdout).errors.length > 0);
    });
  }
});

test('NodeNext distinguishes ESM extension requirements from CommonJS', t => {
  const p = project(t, {
    'tsconfig.json': '{"compilerOptions":{"module":"NodeNext"}}',
    'src/calculate.ts': body,
    'src/esm.mts': "import './calculate'; import './calculate.js';",
    'src/common.cts': "const value = require('./calculate');",
  });
  const result = context(p.root, begin(p.root, 'reuse').run, 'calculate', 5);
  assert.deepEqual(result.errors, []);
  const target = result.candidates.find(c => c.symbol === 'calculate');
  assert.equal(target.importedBy.length, 2);
  assert.equal(result.unresolvedImports.length, 1);
  assert.equal(result.unresolvedImports[0].from, 'src/esm.mts');
});

test('config changes cannot be attributed to a previously captured snapshot', t => {
  const p = project(t, {
    'tsconfig.json': '{"compilerOptions":{"paths":{"shared":["./calculate.js"]}}}',
    'calculate.js': body,
    'consumer.js': "import { calculate } from 'shared';",
  });
  const state = snapshot(p.root);
  p.write('tsconfig.json', '{"compilerOptions":{"paths":{"shared":["./different.js"]}}}');
  assert(indexSources(state, p.root).errors.some(e => /changed since snapshot/.test(e)));
  assert.deepEqual(indexSources(state).errors, []); // Historical checks never consult live configs.
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
  assert(report.findings.some(f => f.rule === 'NEW_DUPLICATION' && f.locations.some(l => l.path === 'src/new.js') && f.locations.length >= 2));
});

test('splitting or shortening historical duplicates does not introduce duplication', async t => {
  const longBody = `export function calculate(value) {\n${Array.from({ length: 24 }, (_, i) => `  value += Math.sqrt(value + ${i});`).join('\n')}\n  return value;\n}`;
  const p = project(t, { 'src/calculate.js': longBody, 'src/old.js': longBody.replace('calculate', 'previous') });
  const run = ready(p.root);
  p.write('src/old.js', longBody.replace('calculate', 'previous').replace('  value += Math.sqrt(value + 12);', '  value = Number(value) * 71;'));
  const split = await check(p.root, run);
  assert(split.currentClones >= 2);
  assert.equal(split.newDuplications, 0);
  p.write('src/old.js', longBody.replace('calculate', 'previous').replace('  value += Math.sqrt(value + 0);', '  value = 37;'));
  assert.equal((await check(p.root, run)).newDuplications, 0);
});

test('expanded duplicates and extra copies have reproducible occurrence evidence', async t => {
  const p = project(t, { 'src/calculate.js': body, 'src/old.js': body.replace('calculate', 'previous') });
  const run = ready(p.root);
  p.write('src/copy.js', body.replace('calculate', 'another'));
  const copies = await check(p.root, run);
  const added = copies.findings.find(f => f.rule === 'NEW_DUPLICATION');
  assert(added);
  assert.equal(added.attribution.kind, 'additional-copy');
  assert.equal(added.attribution.baselineOccurrences, 2);
  assert.equal(added.attribution.currentOccurrences, 3);
  assert(added.attribution.files.some(f => f.path === 'src/copy.js' && f.change === 'added'));
  fs.unlinkSync(path.join(p.root, 'src/copy.js'));
  const expanded = body.replace('  return rows.sort', '  console.log(rows.length);\n  rows.reverse();\n  return rows.sort');
  p.write('src/calculate.js', expanded);
  p.write('src/old.js', expanded.replace('calculate', 'previous'));
  const report = await check(p.root, run);
  assert(report.newDuplications > 0);
  assert(report.findings.filter(f => f.rule === 'NEW_DUPLICATION').every(f => f.attribution.kind === 'new-or-expanded' && f.attribution.baselineOccurrences < 2));
});

test('moving multiple copies with whitespace changes preserves historical duplication', async t => {
  const p = project(t, { 'src/calculate.js': body, 'src/old.js': body.replace('calculate', 'previous'), 'src/third.js': body.replace('calculate', 'third') });
  const run = ready(p.root);
  fs.renameSync(path.join(p.root, 'src/third.js'), path.join(p.root, 'src/aaa.js'));
  p.write('src/old.js', '// shifted\n\n' + body.replace('calculate', 'previous').replaceAll('  ', '    '));
  const report = await check(p.root, run);
  assert.equal(report.newDuplications, 0);
  assert.equal(report.status, 'pass');
});

test('occurrence attribution covers same-file copies and supported tokenizer formats', async t => {
  for (const ext of ['js', 'ts', 'jsx', 'tsx', 'mts', 'cts']) {
    await t.test(ext, async t => {
      const file = `src/calculate.${ext}`;
      const p = project(t, { [file]: body });
      const run = ready(p.root, { file });
      p.write(file, body + '\n' + body.replace('calculate', 'another'));
      const result = await check(p.root, run);
      assert.deepEqual(result.errors, []);
      const found = result.findings.find(f => f.rule === 'NEW_DUPLICATION');
      assert(found);
      assert.equal(found.attribution.baselineOccurrences, 1);
      assert.equal(found.attribution.currentOccurrences, 2);
      assert.deepEqual(found.attribution.files, [{ path: file, change: 'modified' }]);
      assert(found.locations.every(l => l.path === file));
    });
  }
});

test('new copies of a historical subfragment remain visible after a split', async t => {
  const longBody = `export function calculate(value) {\n${Array.from({ length: 24 }, (_, i) => `  value += Math.sqrt(value + ${i});`).join('\n')}\n  return value;\n}`;
  const p = project(t, { 'src/calculate.js': longBody, 'src/old.js': longBody.replace('calculate', 'previous') });
  const run = ready(p.root);
  const fragment = longBody.replace('calculate', 'another').replace('  value += Math.sqrt(value + 12);', '  value = 99;');
  p.write('src/new.js', fragment);
  const result = await check(p.root, run);
  assert.deepEqual(result.errors, []);
  assert(result.newDuplications >= 2);
  for (const f of result.findings.filter(f => f.rule === 'NEW_DUPLICATION')) {
    assert.equal(f.attribution.baselineOccurrences, 2);
    assert.equal(f.attribution.currentOccurrences, 3);
  }
  assert.equal(result.attributionAlgorithm, 'token-occurrences/1');
  const saved = JSON.parse(fs.readFileSync(path.join(p.root, '.terse/runs', run, 'report.json'), 'utf8'));
  assert.deepEqual(saved.findings, result.findings);
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

test('deleted files retain import evidence including new consumers and re-exports', async t => {
  const p = project(t, { 'src/calculate.js': body, 'src/legacy.ts': 'export function legacy() { return 1; }',
    'src/consumer.ts': "import { legacy } from './legacy.js';" });
  const run = ready(p.root, { remove: [{ path: 'src/legacy.ts' }] });
  fs.unlinkSync(path.join(p.root, 'src/legacy.ts'));
  p.write('src/new.ts', "export * from './legacy.js';\nconst load = () => import('./legacy.js');");
  const result = await check(p.root, run);
  assert.equal(result.status, 'fail');
  const references = result.findings.filter(f => f.rule === 'REMOVAL_REFERENCE_REMAINS');
  assert.equal(references.length, 3);
  assert(references.some(f => f.locations[0].path === 'src/new.ts' && f.locations[0].line === 2));
  const processResult = spawnSync(process.execPath, [cli, 'check', '--cwd', p.root, '--run', run, '--json'], { encoding: 'utf8' });
  assert.equal(processResult.status, 1, processResult.stdout + processResult.stderr);
  assert(JSON.parse(processResult.stdout).findings.some(f => f.rule === 'REMOVAL_REFERENCE_REMAINS'));
  p.write('src/consumer.ts', 'export const migrated = 1;');
  p.write('src/new.ts', 'export const migrated = 2;');
  assert.equal((await check(p.root, run)).status, 'pass');
});

test('symbol removal follows named aliases and default exports but permits replacement exports', async t => {
  for (const kind of ['named', 'alias', 'default', 'type', 're-export']) {
    await t.test(kind, async t => {
      const declaration = kind === 'type' ? 'export interface obsolete { value: number }' : kind === 'default'
        ? 'export default function obsolete() { return 1; }' : kind === 'alias'
        ? 'function obsolete() { return 1; }\nexport { obsolete as legacy };' : 'export function obsolete() { return 1; }';
      const consumer = kind === 'default' ? "import local from './legacy';" : kind === 're-export'
        ? "export { obsolete as local } from './legacy';" : `import ${kind === 'type' ? 'type ' : ''}{ ${kind === 'alias' ? 'legacy' : 'obsolete'} as local } from './legacy';`;
      const p = project(t, { 'src/calculate.js': body, 'src/legacy.ts': declaration, 'src/use.ts': consumer });
      const run = ready(p.root, { remove: [{ path: 'src/legacy.ts', symbol: 'obsolete' }] });
      p.write('src/legacy.ts', 'export const other = 1;');
      const result = await check(p.root, run);
      assert.equal(result.status, 'fail');
      assert(result.findings.some(f => f.rule === 'REMOVAL_REFERENCE_REMAINS' && f.locations[0].path === 'src/use.ts'));
      const publicName = kind === 'alias' ? 'legacy' : kind === 'default' ? 'default' : 'obsolete';
      p.write('src/legacy.ts', `function replacement() { return 2; }\nexport { replacement as ${publicName} };`);
      assert.equal((await check(p.root, run)).status, 'pass');
    });
  }
});

test('local residual calls fail while comments, unrelated names and shadowed calls do not', async t => {
  const p = project(t, { 'src/calculate.js': body + '\nexport function obsolete() { return 1; }\n',
    'src/unrelated.js': 'function obsolete() {}\nobsolete();' });
  const run = ready(p.root, { remove: [{ path: 'src/calculate.js', symbol: 'obsolete' }] });
  p.write('src/calculate.js', body + '\nobsolete();\n');
  const result = await check(p.root, run);
  assert.equal(result.status, 'fail');
  assert(result.findings.some(f => f.rule === 'REMOVAL_REFERENCE_REMAINS' && f.locations[0].symbol === 'obsolete'));
  p.write('src/calculate.js', body + '\n// obsolete();\nfunction caller(obsolete) { return obsolete(); }\n');
  assert.equal((await check(p.root, run)).status, 'pass');
});

test('namespace, dynamic and alias references explicitly need cleanup review', async t => {
  const p = project(t, { 'src/calculate.js': body, 'src/legacy.js': 'export function obsolete() { return 1; }',
    'src/use.js': "import * as api from './legacy.js';\nrequire('./legacy.js');\nimport(name);\nimport { obsolete } from '@app/legacy';\nimport 'node:fs';" });
  const run = ready(p.root, { remove: [{ path: 'src/legacy.js', symbol: 'obsolete' }] });
  p.write('src/legacy.js', 'export const other = 2;');
  const result = await check(p.root, run);
  assert.equal(result.status, 'needs-review');
  assert.equal(result.findings.filter(f => f.rule === 'REMOVAL_REFERENCE_UNCERTAIN').length, 2);
  assert.deepEqual(result.findings.find(f => f.rule === 'REMOVAL_REFERENCE_UNRESOLVED').locations.map(l => l.line), [3, 4]);
});

test('current replacement paths take precedence over deleted baseline modules', async t => {
  const p = project(t, { 'src/calculate.js': body, 'src/legacy.js': 'export const value = 1;', 'src/use.js': "import './legacy';" });
  const run = ready(p.root, { remove: [{ path: 'src/legacy.js' }] });
  fs.unlinkSync(path.join(p.root, 'src/legacy.js'));
  p.write('src/legacy/index.js', 'export const value = 2;');
  assert.equal((await check(p.root, run)).status, 'pass');
});

test('removal outside source coverage and member removal cannot silently pass', async t => {
  const p = project(t, { 'src/calculate.js': body, 'src/legacy.js': 'export function obsolete() { return 1; }',
    'src/member.js': 'export class Service {\n  obsolete() { return 1; }\n}' });
  const run = ready(p.root, { remove: [{ path: 'src/legacy.js' }, { path: 'src/member.js', symbol: 'Service.obsolete' }] });
  p.write('src/legacy.js', '// ' + 'x'.repeat(1024 * 1024));
  p.write('src/member.js', 'export class Service {}');
  const result = await check(p.root, run);
  assert.equal(result.status, 'needs-review');
  assert(result.findings.some(f => f.rule === 'REMOVAL_NOT_VERIFIED'));
  assert(result.findings.some(f => f.rule === 'REMOVAL_REFERENCE_UNCERTAIN'));
});

test('forwarding replacements and custom require calls are reviewed rather than declared broken', async t => {
  const p = project(t, { 'src/calculate.js': body, 'src/legacy.js': 'export function obsolete() { return 1; }',
    'src/new.js': 'export function replacement() { return 2; }',
    'src/use.js': "import { obsolete } from './legacy.js';\nfunction loader(require) { return require('./legacy.js'); }" });
  const run = ready(p.root, { remove: [{ path: 'src/legacy.js', symbol: 'obsolete' }] });
  p.write('src/legacy.js', "export { replacement as obsolete } from './new.js';");
  const result = await check(p.root, run);
  assert.equal(result.status, 'needs-review');
  assert.equal(result.findings.filter(f => f.rule === 'REMOVAL_REFERENCE_UNCERTAIN').length, 2);
  assert(!result.findings.some(f => f.severity === 'fail'));
  p.write('src/new.js', 'export function obsolete() { return 2; }');
  p.write('src/legacy.js', "export { obsolete } from './new.js';");
  assert.equal((await check(p.root, run)).status, 'needs-review');
});

test('removing a symbol together with its file checks all remaining module imports', async t => {
  const p = project(t, { 'src/calculate.js': body,
    'src/legacy.js': 'export function obsolete() {}\nexport const other = 2;',
    'src/use.js': "import { other } from './legacy.js';" });
  const run = ready(p.root, { remove: [{ path: 'src/legacy.js', symbol: 'obsolete' }] });
  fs.unlinkSync(path.join(p.root, 'src/legacy.js'));
  const result = await check(p.root, run);
  assert.equal(result.status, 'fail');
  assert(result.findings.some(f => f.rule === 'REMOVAL_REFERENCE_REMAINS' && f.locations[0].path === 'src/use.js'));
});

test('cleanup resolves inherited and nearest aliases for deleted files and new consumers', async t => {
  const p = project(t, {
    'src/calculate.js': body,
    'config/tsconfig.base.json': '{"compilerOptions":{"baseUrl":"..","paths":{"@lib/*":["src/*"]}}}',
    'tsconfig.json': '{"extends":"./config/tsconfig.base.json"}',
    'src/legacy.ts': 'export function obsolete() { return 1; }',
    'src/use.ts': "import { obsolete } from '@lib/legacy';",
    'nested/jsconfig.json': '{"compilerOptions":{"paths":{"legacy":["../src/legacy.ts"]}}}',
    'nested/use.js': "export * from 'legacy';",
  });
  const before = snapshot(p.root);
  const run = ready(p.root, { remove: [{ path: 'src/legacy.ts' }] });
  fs.unlinkSync(path.join(p.root, 'src/legacy.ts'));
  p.write('src/new.ts', "const load = () => import('@lib/legacy');");
  const indexed = indexSources(snapshot(p.root), p.root, before.files);
  assert.deepEqual(indexed.errors, []);
  assert.equal(indexed.imports.length, 3);
  assert(indexed.imports.every(i => i.target === 'src/legacy.ts' && i.targetSnapshot === 'baseline'));
  const result = await check(p.root, run);
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.filter(f => f.rule === 'REMOVAL_REFERENCE_REMAINS').length, 3);
  // Context describes only current files, never restored baseline targets.
  const searched = context(p.root, run, 'load', 5);
  assert.equal(searched.unresolvedImports.length, 3);
  assert(searched.unresolvedImports.every(i => !i.target));
});

test('cleanup resolves named aliases for symbol removal without treating every file import as broken', async t => {
  const p = project(t, { 'src/calculate.js': body,
    'tsconfig.json': '{"compilerOptions":{"paths":{"legacy":["./src/legacy.ts"]}}}',
    'src/legacy.ts': 'export function obsolete() {}\nexport function keep() {}',
    'src/use.ts': "import { obsolete as old } from 'legacy';\nimport { keep } from 'legacy';" });
  const run = ready(p.root, { remove: [{ path: 'src/legacy.ts', symbol: 'obsolete' }] });
  p.write('src/legacy.ts', 'export function keep() {}');
  const result = await check(p.root, run);
  assert.deepEqual(result.errors, []);
  const references = result.findings.filter(f => f.rule === 'REMOVAL_REFERENCE_REMAINS');
  assert.equal(references.length, 1);
  assert.equal(references[0].locations[0].line, 1);
  p.write('src/use.ts', "import { keep } from 'legacy';");
  assert.equal((await check(p.root, run)).status, 'pass');
});

test('current alias fallback and remapping take precedence over deleted baseline targets', async t => {
  const p = project(t, { 'src/calculate.js': body,
    'tsconfig.json': '{"compilerOptions":{"paths":{"legacy":["./src/legacy.ts","./src/replacement.ts"]}}}',
    'src/legacy.ts': 'export const value = 1;', 'src/use.ts': "import { value } from 'legacy';" });
  const before = snapshot(p.root);
  const run = ready(p.root, { remove: [{ path: 'src/legacy.ts' }] });
  fs.unlinkSync(path.join(p.root, 'src/legacy.ts'));
  p.write('src/replacement.ts', 'export const value = 2;');
  const reference = indexSources(snapshot(p.root), p.root, before.files).imports[0];
  assert.equal(reference.target, 'src/replacement.ts');
  assert.equal(reference.targetSnapshot, 'current');
  assert.equal((await check(p.root, run)).status, 'pass');
  p.write('tsconfig.json', '{"compilerOptions":{"paths":{"legacy":["./src/replacement.ts"]}}}');
  assert.equal((await check(p.root, run)).status, 'pass');
});

test('invalid alias config makes cleanup incomplete before verification', async t => {
  const p = project(t, { 'src/calculate.js': body,
    'tsconfig.json': '{"compilerOptions":{"paths":{"legacy":["./src/legacy.ts"]}}}',
    'src/legacy.ts': 'export const value = 1;', 'src/use.ts': "import 'legacy';" });
  const run = ready(p.root, { remove: [{ path: 'src/legacy.ts' }] });
  fs.unlinkSync(path.join(p.root, 'src/legacy.ts'));
  p.write('tsconfig.json', '{"extends":"./tsconfig.missing.json"}');
  const result = await check(p.root, run);
  assert.equal(result.status, 'incomplete');
  assert(result.errors.some(e => e.includes('IMPORT_CONFIG')));
  assert.deepEqual(result.verification, []);
});

test('cleanup preserves NodeNext resolution rules for deleted alias targets', async t => {
  const p = project(t, { 'src/calculate.js': body,
    'tsconfig.json': '{"compilerOptions":{"module":"NodeNext","paths":{"legacy":["./src/legacy.mjs"]}}}',
    'src/legacy.mts': 'export const value = 1;', 'src/use.mts': "import { value } from 'legacy';\nimport './legacy';" });
  const run = ready(p.root, { remove: [{ path: 'src/legacy.mts' }] });
  fs.unlinkSync(path.join(p.root, 'src/legacy.mts'));
  const result = await check(p.root, run);
  assert.deepEqual(result.errors, []);
  assert(result.findings.some(f => f.rule === 'REMOVAL_REFERENCE_REMAINS' && f.locations[0].line === 1));
  assert(result.findings.some(f => f.rule === 'REMOVAL_REFERENCE_UNRESOLVED' && f.locations[0].line === 2));
});

test('CLI contract preserves duplication attribution alongside alias cleanup findings', t => {
  const p = project(t, { 'src/calculate.js': body,
    'tsconfig.json': '{"compilerOptions":{"paths":{"legacy":["./src/legacy.ts"]}}}',
    'src/legacy.ts': 'export function obsolete() { return 1; }',
    'src/use.ts': "import { obsolete } from 'legacy';\nexport const use = () => obsolete();" });
  const run = ready(p.root, { remove: [{ path: 'src/legacy.ts' }] });
  fs.unlinkSync(path.join(p.root, 'src/legacy.ts'));
  p.write('src/copy.js', body.replace('calculate', 'copy'));
  const invoke = () => {
    const processResult = spawnSync(process.execPath, [cli, 'check', '--cwd', p.root, '--run', run, '--json'], { encoding: 'utf8' });
    const result = JSON.parse(processResult.stdout);
    assert.equal(processResult.status, result.exitCode, processResult.stdout);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.outputKind, 'result');
    assert.deepEqual(result.diagnostics, []);
    return result;
  };
  const result = invoke();
  assert.equal(result.status, 'fail');
  assert.equal(result.attributionAlgorithm, 'token-occurrences/1');
  assert(result.findings.some(f => f.rule === 'REMOVAL_REFERENCE_REMAINS' && f.locations[0].path === 'src/use.ts'));
  const duplicate = result.findings.find(f => f.rule === 'NEW_DUPLICATION');
  assert(duplicate);
  assert.equal(duplicate.attribution.baselineOccurrences, 1);
  assert.equal(duplicate.attribution.currentOccurrences, 2);
  assert(duplicate.attribution.files.some(f => f.path === 'src/copy.js' && f.change === 'added'));
  const saved = JSON.parse(fs.readFileSync(path.join(p.root, '.terse/runs', run, 'report.json'), 'utf8'));
  assert.deepEqual(result.findings, saved.findings);
  p.write('src/use.ts', "import { calculate } from './calculate.js';\nexport const use = () => calculate([]);");
  fs.unlinkSync(path.join(p.root, 'src/copy.js'));
  const cleaned = invoke();
  assert.equal(cleaned.status, 'pass');
  assert.equal(cleaned.newDuplications, 0);
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

test('CLI v1 returns a single consistent JSON object for results and every error stage', t => {
  const p = project(t);
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const schema = JSON.parse(fs.readFileSync(new URL('../docs/cli-output.schema.json', import.meta.url), 'utf8'));
  const invoke = (args, cwd = p.root) => {
    const processResult = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd, encoding: 'utf8' });
    assert.equal(processResult.error, undefined);
    assert.equal(processResult.stderr, '');
    const result = JSON.parse(processResult.stdout);
    for (const key of schema.required) assert(Object.hasOwn(result, key), key);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.toolVersion, version);
    assert.equal(result.exitCode, processResult.status);
    assert.equal(result.exitCode, { pass: 0, fail: 1, 'needs-review': 2, incomplete: 3 }[result.status]);
    assert.deepEqual(result.errors, result.diagnostics.map(d => d.message));
    assert(result.diagnostics.every(d => schema.properties.diagnostics.items.properties.code.enum.includes(d.code)));
    assert(!Object.hasOwn(result, 'stack'));
    return result;
  };
  const help = invoke(['--help']);
  assert.equal(help.command, 'help');
  assert.match(help.help, /terse begin/);
  assert.equal(invoke([]).command, 'help');
  assert.equal(invoke(['--version']).command, 'version');
  assert.equal(invoke(['--version', '--help']).command, 'version');
  const invalidOption = invoke(['begin', '--unknown']);
  assert.equal(invalidOption.command, null);
  assert.equal(invalidOption.outputKind, 'error');
  assert.equal(invalidOption.diagnostics[0].code, 'INVALID_ARGUMENT');
  assert.equal(invoke(['constructor']).diagnostics[0].code, 'INVALID_ARGUMENT');
  const missing = invoke(['begin', '--cwd', path.join(p.root, 'missing')]);
  assert.equal(missing.command, 'begin');
  assert.equal(missing.diagnostics[0].code, 'INVALID_ARGUMENT');
  const projectError = invoke(['begin', '--task', 'x', '--cwd', path.join(p.root, 'missing')]);
  assert.equal(projectError.diagnostics[0].code, 'PROJECT_ERROR');
  assert.equal(projectError.diagnostics[0].stage, 'project');
  const commandError = invoke(['check', '--run', '0000000000000-00000000-0000-0000-0000-000000000000']);
  assert.equal(commandError.command, 'check');
  assert.equal(commandError.outputKind, 'error');
  assert.equal(commandError.diagnostics[0].code, 'COMMAND_ERROR');
  assert(!Object.hasOwn(commandError, 'findings'));
  const begun = invoke(['begin', '--task', 'contract']);
  assert.equal(begun.outputKind, 'result');
  assert.equal(begun.status, 'pass');
  assert.equal(invoke(['context', '--run', begun.run, '--query', 'calculate']).status, 'pass');
  const review = invoke(['check', '--run', begun.run]);
  assert.equal(review.status, 'needs-review');
  assert.deepEqual(review.diagnostics, []);
  assert(review.findings.length > 0);
  const run = ready(p.root);
  const passed = invoke(['check', '--run', run]);
  assert.equal(passed.status, 'pass', JSON.stringify(passed));
  const saved = JSON.parse(fs.readFileSync(path.join(p.root, '.terse/runs', run, 'report.json'), 'utf8'));
  for (const [key, value] of Object.entries(saved)) assert.deepEqual(passed[key], value);
  assert(!Object.hasOwn(saved, 'schemaVersion'));
  p.write('src/broken.ts', 'export function broken( {');
  const incomplete = invoke(['check', '--run', run]);
  assert.equal(incomplete.outputKind, 'result');
  assert.equal(incomplete.status, 'incomplete');
  assert(incomplete.diagnostics.every(d => d.code === 'CHECK_INCOMPLETE'));
  assert(incomplete.findings);
  const partial = invoke(['context', '--run', run, '--query', 'calculate']);
  assert.equal(partial.status, 'incomplete');
  assert(partial.candidates.length > 0);
  assert(partial.diagnostics.every(d => d.code === 'CONTEXT_INCOMPLETE'));
  fs.writeFileSync(path.join(p.root, '.terse/runs', run, 'baseline.json'), '{');
  assert.equal(invoke(['check', '--run', run]).outputKind, 'error');
});

test('CLI distinguishes rule failures from execution errors and keeps text mode usable', t => {
  const p = project(t, undefined, { verification: [{ command: 'node', args: ['-e', 'console.log("validation output"); process.exit(1)'] }] });
  const run = ready(p.root);
  const checked = spawnSync(process.execPath, [cli, 'check', '--run', run, '--cwd', p.root, '--json'], { encoding: 'utf8' });
  const result = JSON.parse(checked.stdout);
  assert.equal(checked.status, 1, checked.stdout + checked.stderr);
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, 'fail');
  assert.equal(result.outputKind, 'result');
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.verification[0].output, /validation output/);
  assert.equal(checked.stderr, '');
  for (const args of [['--help'], ['--version'], ['check', '--run', run], ['check', '--run', 'invalid'], ['begin']]) {
    const text = spawnSync(process.execPath, [cli, ...args, '--cwd', p.root], { encoding: 'utf8' });
    assert(text.stdout.trim().length > 0);
    assert.equal(text.stderr, '');
    assert.doesNotMatch(text.stdout, /TypeError:|at render/);
    if (args[0] === 'begin') assert.match(text.stdout, /INVALID_ARGUMENT/);
    if (args.includes('invalid')) assert.match(text.stdout, /COMMAND_ERROR/);
  }
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
      assert.equal(error.code, expected.source.split('.*')[0]);
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

test('M1 CLI exposes baseline error categories through the v1 diagnostic contract', t => {
  const p = project(t);
  const run = ready(p.root);
  const file = path.join(p.root, '.terse/runs', run, 'baseline.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cases = [
    ['INVALID_JSON', () => fs.writeFileSync(file, '{"secret": "do-not-print-this')],
    ['JSON_READ_FAILED', () => fs.unlinkSync(file)],
    ['BASELINE_INVALID', () => fs.writeFileSync(file, 'null')],
    ['BASELINE_INCOMPATIBLE', () => fs.writeFileSync(file, JSON.stringify({ ...original, schema: 2 }))],
    ['BASELINE_INTEGRITY', () => fs.writeFileSync(file, JSON.stringify({ ...original, snapshot: { ...original.snapshot, hash: '0'.repeat(64) } }))],
    ['INVALID_RUN_ID', () => {}, 'invalid'],
    ['RUN_NOT_FOUND', () => {}, `1234567890123-${run.slice(14)}`],
  ];
  for (const command of ['context', 'check']) {
    for (const [code, corrupt, requestedRun = run] of cases) {
      fs.writeFileSync(file, JSON.stringify(original));
      corrupt();
      const args = [cli, command, '--run', requestedRun, '--cwd', p.root, '--json', ...(command === 'context' ? ['--query', 'calculate'] : [])];
      const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(result.status, 3);
      assert.equal(result.stderr, '');
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, 'incomplete');
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.command, command);
      assert.equal(report.outputKind, 'error');
      assert.equal(report.exitCode, 3);
      assert.deepEqual(report.diagnostics, [{ code: 'COMMAND_ERROR', stage: 'command', causeCode: code, message: report.errors[0] }]);
      if (requestedRun === run) assert(report.errors[0].includes(file));
      assert.match(report.errors[0], /terse begin/);
      assert(!result.stdout.includes('do-not-print-this'));
      assert(!Object.hasOwn(report, 'findings'));
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
  const result = spawnSync(process.execPath, [cli, 'check', '--cwd', p.root, '--run', run, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).diagnostics[0].causeCode, 'BASELINE_INTEGRITY');
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
