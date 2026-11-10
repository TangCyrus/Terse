import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {captureChangeBaseline, collectChanges, verifyCommand} from '../scripts/lib/benchmark-project.mjs';
import {freezeTestCases, testEvidence} from '../scripts/lib/test-evidence.mjs';
import {prepareEvaluation} from '../scripts/lib/evaluation-project.mjs';
import {cases} from '../scripts/evaluation-cases.mjs';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-integrity-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-integrity-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  return root;
}
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']});
const write = (root, file, bytes) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), bytes);
};
const env = {...process.env, FORCE_COLOR: '0'};delete env.NODE_TEST_CONTEXT;

test('frozen patches include staged and unstaged edits, staged additions/deletions/renames and binary data without touching the index', t => {
  const root = workspace(t);git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  for (const file of ['edit.ts', 'remove.ts', 'rename.ts']) write(root, `src/${file}`, `export const value = '${file}';\n`);
  write(root, '.gitignore', '.terse/\n');git(root, 'add', '.');
  const baseline = captureChangeBaseline(root);
  write(root, 'src/edit.ts', 'export const stage = 1;\n');
  fs.unlinkSync(path.join(root, 'src/remove.ts'));
  fs.renameSync(path.join(root, 'src/rename.ts'), path.join(root, 'src/renamed.ts'));
  write(root, 'src/new.bin', Buffer.from([0, 1, 2, 255]));
  write(root, 'unexpected.md', 'outside source\n');git(root, 'add', '.');
  write(root, 'src/edit.ts', 'export const stage = 1;\nexport const unstaged = 2;\n');
  write(root, 'src/订单 [helper].ts', 'export const added = 3;\n');
  const index = fs.readFileSync(path.join(root, '.git/index'));
  const result = collectChanges(root, ['src/'], baseline);
  assert.deepEqual(result.changed, ['src/edit.ts', 'src/new.bin', 'src/remove.ts', 'src/rename.ts', 'src/renamed.ts', 'src/订单 [helper].ts', 'unexpected.md']);
  assert.deepEqual(result.outsideScope, ['unexpected.md']);
  assert.match(result.patch, /unstaged = 2/);assert.match(result.patch, /GIT binary patch/);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), index);
  assert.deepEqual(collectChanges(root, ['src/'], baseline), result, 'Repeated collection must not erase the patch');
  // Reconstruct the exact candidate files using only the emitted patch.
  const replay = path.join(root, 'replay');fs.mkdirSync(replay);git(replay, 'init', '-q');
  git(replay, 'config', 'core.autocrlf', 'false');
  for (const file of ['edit.ts', 'remove.ts', 'rename.ts']) write(replay, `src/${file}`, `export const value = '${file}';\n`);
  write(replay, '.gitignore', '.terse/\n');git(replay, 'add', '.');
  execFileSync('git', ['-C', replay, 'apply', '--binary', '-'], {input: result.patch, stdio: ['pipe', 'pipe', 'pipe']});
  for (const file of result.changed) {
    if (fs.existsSync(path.join(root, file))) assert.deepEqual(fs.readFileSync(path.join(replay, file)), fs.readFileSync(path.join(root, file)));
    else assert.equal(fs.existsSync(path.join(replay, file)), false);
  }
});

test('baseline includes inherited staged, unstaged and untracked work instead of HEAD and survives index reset', t => {
  const root = workspace(t);git(root, 'init', '-q');
  write(root, 'src/value.ts', 'export const value = 0;\n');git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial');
  write(root, 'src/value.ts', 'export const inheritedStage = 1;\n');git(root, 'add', '.');
  write(root, 'src/value.ts', 'export const inheritedStage = 1;\nexport const inheritedWork = 2;\n');
  write(root, 'src/untracked.ts', 'export const inheritedNew = 3;\n');
  const index = fs.readFileSync(path.join(root, '.git/index'));
  const baseline = captureChangeBaseline(root);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), index);
  assert.deepEqual(collectChanges(root, ['src/'], baseline), {changed: [], outsideScope: [], patch: ''});
  git(root, 'reset', '-q', 'HEAD');
  assert.deepEqual(collectChanges(root, ['src/'], baseline), {changed: [], outsideScope: [], patch: ''});
  fs.appendFileSync(path.join(root, 'src/value.ts'), 'export const taskEdit = 4;\n');git(root, 'add', '.');
  const result = collectChanges(root, ['src/'], baseline);
  assert.deepEqual(result.changed, ['src/value.ts']);
  assert.match(result.patch, /\+export const taskEdit = 4/);
  assert.doesNotMatch(result.patch, /\+export const inherited/);
});

test('unborn empty repositories and removed-from-index ignored baseline paths remain observable', t => {
  const root = workspace(t);git(root, 'init', '-q');
  const empty = captureChangeBaseline(root);
  assert.deepEqual(collectChanges(root, ['src/'], empty).changed, []);
  write(root, 'src/old.ts', 'export const value = 1;\n');git(root, 'add', '.');
  const baseline = captureChangeBaseline(root);
  git(root, 'rm', '--cached', '-q', 'src/old.ts');
  write(root, '.gitignore', 'src/old.ts\n');
  fs.appendFileSync(path.join(root, 'src/old.ts'), 'export const stillHere = 2;\n');
  assert.deepEqual(collectChanges(root, ['src/'], baseline).changed, ['.gitignore', 'src/old.ts']);
  assert.throws(() => collectChanges(root, ['src/']), /frozen task baseline/);
});

test('orders acceptance rejects three file-level passes from early exit, while original failures and real solutions retain their outcome', t => {
  const parent = workspace(t), scenario = cases.find(item => item.id === 'modify');
  const {project, sources, config} = prepareEvaluation(parent, 'orders', scenario);
  const args = config.verification[0].args, expectedCases = freezeTestCases(project, args);
  const protectedHash = () => createHash('sha256').update(args.slice(1).map(file => fs.readFileSync(path.join(project, file))).join('\0')).digest('hex');
  const before = protectedHash();
  const verify = label => verifyCommand(project, label, args, parent, {env, expectedCases});
  assert.equal(verify('unmet').passed, false);
  const original = sources.read('orders.ts');
  sources.write('orders.ts', 'process.exit(0);\n' + original);
  const old = spawnSync(process.execPath, args, {cwd: project, env, encoding: 'utf8'});
  assert.equal(old.status, 0);assert.match(old.stdout, /tests 3\b/);assert.match(old.stdout, /pass 3\b/);
  const rejected = verify('early-exit');
  assert.equal(rejected.exitCode, 0);assert.equal(rejected.passed, false);
  assert.equal(rejected.testEvidence.missing.length, 3);
  assert(rejected.testEvidence.unexpected.every(name => !name.includes(project)), 'Portable failure evidence must omit host paths');
  assert.equal(protectedHash(), before, 'The exploit must not alter protected tests');
  sources.write('orders.ts', original);
  scenario.variants.find(item => item.id === 'reuse').edit(sources);
  const good = verify('solution');assert.equal(good.passed, true);
  assert.equal(good.testEvidence.expected, 3);assert.equal(good.testEvidence.counts.passed, 3);
});

test('named-case evidence rejects partial, skipped, todo, cancelled, timed-out and spoofed acceptance', async t => {
  for (const [mode, candidate, options] of [
    ['healthy', 'export const run = () => {}; console.log("noisy stdout: tests 3 pass 3");', {}],
    ['failed', 'export const run = () => {throw new Error("behavior failed")};', {}],
    ['partial', 'export const run = () => process.exit(0);', {}],
    ['skip', 'export const run = t => t.skip("not executed");', {}],
    ['todo', 'export const run = t => t.todo("not implemented");', {}],
    ['cancelled', 'export const run = t => t.test("unfinished",{timeout:20},()=>new Promise(()=>{}));', {}],
    ['timeout', 'export const run = () => new Promise(resolve=>setTimeout(resolve,2000));', {testTimeout: 100}],
    ['spoof', 'console.log(JSON.stringify({type:"test:pass",data:{name:"first"}}));process.exit(0);export const run=()=>{};', {}],
  ]) await t.test(mode, t => {
    const root = workspace(t);
    write(root, 'source.mjs', candidate);
    write(root, 'one.test.mjs', 'import test from "node:test";import {run} from "./source.mjs";test("first",async t=>{await run(t);});test("second",()=>{});');
    const args = ['--test', 'one.test.mjs'], expectedCases = freezeTestCases(root, args);
    const result = verifyCommand(root, mode, [`--test-timeout=${options.testTimeout ?? 3000}`, ...args], root, {env, expectedCases});
    assert.equal(result.passed, mode === 'healthy');
    assert.match(result.logHash, /^[a-f0-9]{64}$/);
    if (['partial', 'skip', 'todo', 'spoof'].includes(mode)) assert.equal(result.exitCode, 0);
    if (mode === 'timeout') assert.notEqual(result.exitCode, 0);
  });
});

test('manifests remain frozen across test edits and missing or truncated reporter evidence never passes', t => {
  const root = workspace(t);write(root, 'test.mjs', 'import test from "node:test";test("original",()=>{});');
  const args = ['--test', 'test.mjs'], expectedCases = freezeTestCases(root, args);
  write(root, 'test.mjs', 'import test from "node:test";test("replacement",()=>{});');
  const result = verifyCommand(root, 'changed-test', args, root, {env, expectedCases});
  assert.equal(result.exitCode, 0);assert.equal(result.passed, false);
  assert.deepEqual(result.testEvidence.missing, ['original']);
  assert.equal(testEvidence('', expectedCases).passed, false);
  const log = fs.readFileSync(path.join(root, 'changed-test.log'), 'utf8');
  assert.equal(testEvidence(log.slice(0, -50), expectedCases).passed, false);
  assert.throws(() => verifyCommand(root, 'no-manifest', args, root, {env}), /frozen test identities/);
});
