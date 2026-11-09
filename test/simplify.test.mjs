import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createWorkspace, invoke, repository} from '../scripts/lib/workspace.mjs';
import {begin} from '../dist/project.js';
import {context} from '../dist/analyze.js';
import {simplify, sourceMetrics} from '../dist/simplify.js';

const body = '{\n  const doubled = value * 2;\n  if (doubled < 0) throw new Error("negative");\n  const result = doubled + 7;\n  return result;\n}';
const pair = (implementation = body, parameters = 'value: number', prefix = 'export function', suffix = '') =>
  `${prefix} shared(${parameters}) ${implementation}\n${prefix} redundant(${parameters}) ${implementation}\n${suffix}`;

test('source metrics count parsed template and regex tokens without trivia or JSDoc', () => {
  assert.equal(sourceMetrics('export const template = `x ${value} y ${other}`; export const tail = 1;').tokens, 16);
  assert.equal(sourceMetrics('/** @type {RegExp} */\n export const pattern = /a  b\\/c/gi; // comment').tokens, 6);
});
function project(t, content = pair(), verification) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-simplify-'));
  t.after(() => {
    const resolved = fs.realpathSync(parent);assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-simplify-'));fs.rmSync(resolved, {recursive:true, force:true});
  });
  const root = createWorkspace(parent, 'project'), file = path.join(root, 'src/pair.ts');
  fs.writeFileSync(file, content);
  if (verification) fs.writeFileSync(path.join(root, 'terse.config.json'), JSON.stringify({verification}));
  const started = begin(root, 'Consolidate duplicate bodies');
  const found = context(root, started.run, 'shared redundant', 20);
  const ids = ['redundant', 'shared'].map(name => found.candidates.find(item => item.symbol === name)?.candidateId);
  assert(ids.every(Boolean));
  return {root, file, run:started.run, ids, execute:(apply = false) => simplify(root, started.run, ...ids, apply),
    save:() => invoke(root, ['decide', '--run', started.run, '--strategy', 'refactor', '--candidate', ids[0], '--candidate', ids[1], '--rationale', 'Retain both contracts with one body.'])};
}

test('simplify previews a real reduction without writes and preserves exact executable edit identity', async t => {
  const p = project(t), before = fs.readFileSync(p.file, 'utf8');
  const preview = await p.execute();
  assert.equal(preview.status, 'needs-review');assert.equal(preview.applied, false);assert.equal(preview.simplificationVerified, false);
  assert.equal(fs.readFileSync(p.file, 'utf8'), before);
  assert.equal(preview.plan.edit.before, body);assert.equal(preview.plan.edit.after, '{ return shared(value); }');
  assert(preview.plan.metrics.removedTokens > 0 && preview.plan.metrics.removedBytes > 0);
  assert.equal(preview.plan.metrics.matchingBodiesBefore, 2);assert.equal(preview.plan.metrics.matchingBodiesAfter, 1);
  assert(!fs.existsSync(path.join(p.root, '.terse/runs', p.run, 'simplification.json')));
  const schema = JSON.parse(fs.readFileSync(path.join(repository, 'docs/cli-output.schema.json')));
  const cli = invoke(p.root, ['simplify', '--run', p.run, '--candidate', p.ids[0], '--into', p.ids[1]], 2);
  const branch = schema.allOf.at(-1).then.oneOf.find(item => item.properties.command.const === 'simplify');
  for (const key of [...schema.required, ...branch.required]) assert(Object.hasOwn(cli, key), key);
  assert.deepEqual(cli.plan, preview.plan);assert(!Object.hasOwn(cli, 'verificationGuide'));
});

test('automatic delegation refuses context-sensitive or ambiguous code without touching source', async t => {
  const cases = [
    ['this', pair(body.replace('value * 2', 'this.value * 2'))],
    ['arguments', pair(body.replace('value * 2', 'arguments[0] * 2'))],
    ['new.target', pair(body.replace('value * 2', 'new.target ? value : 2'))],
    ['recursive', pair(body.replace('value * 2', 'shared(value)'))],
    ['default', pair(body, 'value: number = 1')],
    ['rest', pair(body, '...value: number[]')],
    ['destructure', pair(body, '{value}: {value:number}')],
    ['this parameter', pair(body, 'this:unknown, value:number')],
    ['async', pair(body, 'value: number', 'export async function')],
    ['generator', pair(body, 'value: number', 'export function*')],
    ['generic', pair().replaceAll('(value: number)', '<T>(value: number)')],
    ['directive', pair(body.replace('{', '{"use strict";'))],
    ['direct eval', pair(body, 'value:number', 'export function', 'function other(code: string) {return eval(code);}')],
    ['write', pair(body, 'value:number', 'export function', 'shared = replacement;')],
    ['destructuring write', pair(body, 'value:number', 'export function', '[shared] = replacements;')],
    ['loop write', pair(body, 'value:number', 'export function', 'for (shared of replacements) {}')],
    ['shadow', pair(body, 'shared:number, value:number')],
    ['escaped shadow', pair(body, String.raw`sh\u0061red:number, value:number`)],
    ['overload', 'export function shared(value:number):number;\n' + pair()],
    ['nested same name', pair(body, 'value:number', 'export function', 'function outer(){function shared(){} return shared;}')],
    ['script global', pair(body, 'value:number', 'function')],
    ['arrow', `export const shared = (value:number) => ${body};\nexport const redundant = (value:number) => ${body};`],
  ];
  for (const [name, content] of cases) await t.test(name, async t => {
    const p = project(t, content);
    await assert.rejects(p.execute(), error => error.code === 'SIMPLIFY_UNSUPPORTED');
    assert.equal(fs.readFileSync(p.file, 'utf8'), content);
  });
});

test('body and signature differences, regex whitespace and non-reductions cannot be merged', async t => {
  const cases = [
    ['signature', pair().replace('redundant(value: number)', 'redundant(value: any)'), 'SIMPLIFY_NOT_IDENTICAL'],
    ['body', pair().replace('const result = doubled + 7;', 'const result = doubled + 8;'), 'SIMPLIFY_NOT_IDENTICAL'],
    ['regex', 'export function shared(value:string) { return /a b/.test(value); }\nexport function redundant(value:string) { return /a  b/.test(value); }', 'SIMPLIFY_NOT_IDENTICAL'],
    ['small body', pair('{return value;}'), 'SIMPLIFY_NO_REDUCTION'],
  ];
  for (const [name, content, code] of cases) await t.test(name, async t => {
    const p = project(t, content);await assert.rejects(p.execute(), error => error.code === code);
    assert.equal(fs.readFileSync(p.file, 'utf8'), content);
  });
});

test('tagged templates retain separate cached site identities and cannot be automatically delegated', async t => {
  const observe = second => new Function('const sites = new WeakMap(); let next = 0; '
    + 'function tag(strings) {if (!sites.has(strings)) sites.set(strings, ++next); return sites.get(strings);} '
    + 'function shared() {return tag`item`;} function redundant() {' + second + '} '
    + 'return [shared(), redundant(), shared(), redundant()];')();
  assert.deepEqual(observe('return tag`item`;'), [1, 2, 1, 2]);
  assert.deepEqual(observe('return shared();'), [1, 1, 1, 1]);
  for (const expression of ['tag`item`', 'tag`item:${value}`']) {
    const content = pair(`{const selected = ${expression}; const total = selected + value; return total;}`);
    const p = project(t, content);
    await assert.rejects(p.execute(), error => error.code === 'SIMPLIFY_UNSUPPORTED');
    p.save();
    await assert.rejects(p.execute(true), error => error.code === 'SIMPLIFY_UNSUPPORTED');
    assert.equal(fs.readFileSync(p.file, 'utf8'), content);
    assert(!fs.existsSync(path.join(p.root, '.terse/runs', p.run, 'simplification.json')));
  }
});

test('stale candidates and invalid choices fail before source edits', async t => {
  const p = project(t), original = fs.readFileSync(p.file, 'utf8');
  fs.writeFileSync(p.file, original.replace('const doubled = value * 2;', 'const doubled = value * 3;'));
  await assert.rejects(p.execute(), error => error.code === 'SIMPLIFY_STALE');
  fs.writeFileSync(p.file, original);
  await assert.rejects(simplify(p.root, p.run, p.ids[0], p.ids[0]), error => error.code === 'SIMPLIFY_SCOPE');
  await assert.rejects(simplify(p.root, p.run, p.ids[0], 'unknown'), error => error.code === 'SIMPLIFY_CANDIDATE');
  assert.equal(fs.readFileSync(p.file, 'utf8'), original);
});

test('apply requires both accepted candidates and real configured verification', async t => {
  const p = project(t), original = fs.readFileSync(p.file, 'utf8');
  await assert.rejects(p.execute(true), error => error.code === 'DECISION_INVALID');
  invoke(p.root, ['decide', '--run', p.run, '--strategy', 'refactor', '--candidate', p.ids[0], '--rationale', 'Incomplete choice.']);
  await assert.rejects(p.execute(true), error => error.code === 'SIMPLIFY_DECISION');
  assert.equal(fs.readFileSync(p.file, 'utf8'), original);
  const config = path.join(p.root, 'terse.config.json');fs.writeFileSync(config, '{"verification":[]}');
  const fresh = begin(p.root, 'No verification');const found = context(p.root, fresh.run, 'shared redundant', 10);
  const ids = ['redundant', 'shared'].map(name => found.candidates.find(item => item.symbol === name).candidateId);
  await assert.rejects(simplify(p.root, fresh.run, ...ids, true), error => error.code === 'SIMPLIFY_VERIFICATION');
  assert.equal(fs.readFileSync(p.file, 'utf8'), original);
});

test('failing verification never claims a verified simplification or silently undoes the actual edit', async t => {
  const p = project(t);p.save();
  // This independent existing test now fails; simplify must run it in addition
  // to preserving the proposed patch, rather than masking failure as reduction.
  fs.appendFileSync(path.join(p.root, 'test/orders.test.mjs'), '\ntest("required failure", () => assert.equal(1, 2));\n');
  const env = {...process.env};delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(repository, 'dist/cli.js'), 'simplify', '--cwd', p.root, '--run', p.run,
    '--candidate', p.ids[0], '--into', p.ids[1], '--apply', '--summary', '--json'], {encoding:'utf8', env});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);assert.equal(output.applied, true);assert.equal(output.simplificationVerified, false);
  assert(output.report.verification.some(item => item.status === 'failed'));
  assert(output.report.verification.every(item => item.outputOmitted));assert.equal(output.report.detail, 'summary');
  assert(fs.readFileSync(p.file, 'utf8').includes('function redundant(value: number) { return shared(value); }'));
  const stored = JSON.parse(fs.readFileSync(path.join(p.root, '.terse/runs', p.run, 'simplification.json')));
  assert.equal(stored.simplificationVerified, false);assert.deepEqual(stored.plan, output.plan);
});

test('verification errors retain incomplete diagnostics and cannot masquerade as completed reduction', async t => {
  const p = project(t), config = path.join(p.root, 'terse.config.json');
  fs.writeFileSync(config, JSON.stringify({verification:[{command:'terse-missing-simplification-verifier', args:[]}]}));
  const started = begin(p.root, 'Consolidate with required verification');
  const found = context(p.root, started.run, 'shared redundant', 10);
  const ids = ['redundant', 'shared'].map(name => found.candidates.find(item => item.symbol === name).candidateId);
  invoke(p.root, ['decide', '--run', started.run, '--strategy', 'refactor', '--candidate', ids[0], '--candidate', ids[1], '--rationale', 'Keep one body.']);
  const result = invoke(p.root, ['simplify', '--run', started.run, '--candidate', ids[0], '--into', ids[1], '--apply'], 3);
  assert.equal(result.status, 'incomplete');assert.equal(result.applied, true);assert.equal(result.simplificationVerified, false);
  assert(result.errors.length > 0);assert.deepEqual(result.errors, result.diagnostics.map(item => item.message));
});

test('scope and coverage restrictions reject unverified edits and skip-verification flags', async t => {
  const p = project(t), original = fs.readFileSync(p.file, 'utf8');
  fs.writeFileSync(path.join(p.root, 'src/large.js'), ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(p.execute(true), error => error.code === 'SIMPLIFY_COVERAGE');
  fs.unlinkSync(path.join(p.root, 'src/large.js'));
  const skipped = invoke(p.root, ['simplify', '--run', p.run, '--candidate', p.ids[0], '--into', p.ids[1], '--skip-verification'], 3);
  assert.equal(skipped.diagnostics[0].code, 'INVALID_ARGUMENT');
  fs.writeFileSync(path.join(p.root, 'terse.config.json'), JSON.stringify({minTokens:60}));
  await assert.rejects(p.execute(), error => error.code === 'SIMPLIFY_POLICY');
  assert.equal(fs.readFileSync(p.file, 'utf8'), original);
});

test('a verifier changing source withholds reduction credit and retains current edits', async t => {
  const p = project(t, pair(), [{command:'node', args:['-e', 'require("node:fs").appendFileSync("src/pair.ts", "\\n// changed during verification\\n")']}]);
  p.save();
  const result = await p.execute(true);
  assert.equal(result.status, 'incomplete');assert.equal(result.simplificationVerified, false);assert(result.errors.length > 0);
  assert(fs.readFileSync(p.file, 'utf8').includes('// changed during verification'));
});

test('BOM-prefixed sources apply successfully with the encoding marker and source mode preserved', async t => {
  const acceptance = 'import assert from "node:assert/strict"; import {shared,redundant} from "./src/pair.ts"; for(const fn of [shared,redundant]) {assert.equal(fn(3),13);assert.equal(fn(0),7);assert.throws(()=>fn(-1),/negative/);}';
  const p = project(t, '\ufeff' + pair(), [{command:'node', args:['--input-type=module', '-e', acceptance]}]);
  if (process.platform !== 'win32') {
    fs.chmodSync(p.file, 0o640);
    const previous = process.umask(0o077);t.after(() => process.umask(previous));
  }
  const mode = fs.statSync(p.file).mode & 0o777;
  const preview = await p.execute();assert.equal(preview.plan.metrics.before.bytes, Buffer.byteLength(pair()));
  p.save();
  const result = await p.execute(true);assert.equal(result.simplificationVerified, true);
  assert.deepEqual(result.report.verification.map(item => item.status), ['passed']);
  const bytes = fs.readFileSync(p.file);
  assert(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  assert.equal(bytes.length, result.plan.metrics.after.bytes + 3);
  assert.equal(fs.statSync(p.file).mode & 0o777, mode);
});

test('cross-file candidates are refused rather than injecting imports or a new abstraction', async t => {
  const p = project(t);fs.writeFileSync(path.join(p.root, 'src/other.ts'), `export function external(value: number) ${body}`);
  const started = begin(p.root, 'Compare cross-file candidates'), found = context(p.root, started.run, 'external redundant', 10);
  const ids = ['redundant', 'external'].map(name => found.candidates.find(item => item.symbol === name).candidateId);
  await assert.rejects(simplify(p.root, started.run, ...ids, true), error => error.code === 'SIMPLIFY_SCOPE');
  assert.equal(fs.readFileSync(p.file, 'utf8'), pair());
});

test('executable demo removes existing duplicate code then adds a feature without restoring a second body', t => {
  const result = spawnSync(process.execPath, [path.join(repository, 'scripts/demo-simplify.mjs')], {encoding:'utf8', timeout:120000});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.modelSessions, 0);assert.equal(summary.existing.applied, true);assert.equal(summary.existing.verified, true);
  assert(summary.existing.removedBytes > 0 && summary.existing.removedTokens > 0);
  assert.equal(summary.existing.matchingBodiesBefore, 2);assert.equal(summary.existing.matchingBodiesAfter, 1);
  assert(summary.netRemovedSourceBytes > 0);assert(summary.netRemovedSourceTokens > 0);
  const [modify, copy] = summary.feature;
  assert.equal(modify.baselineHash, copy.baselineHash);assert.equal(modify.status, 'pass');assert.equal(modify.independentExportBodies, 1);
  assert.equal(copy.independentExportBodies, 2);assert(modify.addedSourceBytes < copy.addedSourceBytes);
  for (const item of [summary.existing, modify, copy]) assert.deepEqual(item.verification, ['passed', 'passed']);
  assert.deepEqual(JSON.parse(fs.readFileSync(summary.evidence)).existing, summary.existing);
  t.diagnostic(JSON.stringify({existing:summary.existing, feature:summary.feature.map(({variant, addedSourceBytes, independentExportBodies}) => ({variant, addedSourceBytes, independentExportBodies})), netRemovedSourceBytes:summary.netRemovedSourceBytes}));
});
