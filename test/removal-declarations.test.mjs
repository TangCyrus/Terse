import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {indexSources} from '../dist/analyze.js';
import {undeclaredRemovals} from '../dist/cleanup.js';
import {digest, parseConfig} from '../dist/project.js';
import {createWorkspace, invoke} from '../scripts/lib/workspace.mjs';

const state = (files, skipped = []) => ({files: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, {content, hash: digest(content)}])),
  metadata: {}, config: parseConfig({}), skipped, hash: 'unit snapshot'});
const missing = (before, after, declared = []) => undeclaredRemovals(before, after, indexSources(before), indexSources(after), declared);
function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-removal-'));
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('terse-removal-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const root = createWorkspace(parent, 'project');
  const write = (file, text) => fs.writeFileSync(path.join(root, file), text);
  return {root, write, run: (args, code = 0) => invoke(root, args, code)};
}

test('removal inference uses baseline path/name and collapses parents by exact AST spans', () => {
  const before = state({'file.ts': 'export function outer() {const nested = () => 1; return nested();} export function sibling() {return 2;}',
    'gone.ts': 'export class Gone { method() {const local = () => 0;} }'});
  const after = state({'file.ts': 'export const value = 1;'});
  assert.deepEqual(missing(before, after), [{path: 'gone.ts'}, {path: 'file.ts', symbol: 'outer'}, {path: 'file.ts', symbol: 'sibling'}]);
  assert.deepEqual(missing(before, after, [{path: 'gone.ts', symbol: 'Gone'}, {path: 'file.ts', symbol: 'outer'}]),
    [{path: 'gone.ts'}, {path: 'file.ts', symbol: 'sibling'}]);
  assert.deepEqual(missing(before, after, [{path: 'gone.ts'}, {path: 'file.ts', symbol: 'outer'}, {path: 'file.ts', symbol: 'sibling'}]), []);
  const classes = state({'file.ts': 'export class Gone { old() {const nested = () => 1;} } export class Kept {old() {}}'});
  assert.deepEqual(missing(classes, state({'file.ts': 'export class Kept {old() {}}'})), [{path: 'file.ts', symbol: 'Gone'}]);
});

test('moves, renames and forwarding facades need old declarations; in-place changes and additions do not', () => {
  const before = state({'old.ts': 'export function work() {return 1;}'});
  assert.deepEqual(missing(before, state({'old.ts': 'export function renamed() {return 1;}'})), [{path: 'old.ts', symbol: 'work'}]);
  assert.deepEqual(missing(before, state({'old.ts': 'export {work} from "./new.js";', 'new.ts': before.files['old.ts'].content})), [{path: 'old.ts', symbol: 'work'}]);
  assert.deepEqual(missing(before, state({'old.ts': 'export const work = () => 2;', 'new.ts': 'export function extra() {}'})), []);
  const overloaded = state({'old.ts': 'export function work(a: string): string; export function work(a: number): number; export function work(a: any) {return a;}'});
  assert.deepEqual(missing(overloaded, state({'old.ts': 'export function work(a: number): number; export function work(a: any) {return a;}'})), []);
});

test('losing scan coverage is not inferred as a confirmed deletion', () => {
  const before = state({'old.ts': 'export function old() {}'});
  for (const reason of ['excluded', 'symlink', 'binary', 'over-1MiB']) assert.deepEqual(missing(before, state({}, [{path: 'old.ts', reason}])), []);
});

test('M5 missing private removals fail for every strategy, preserve full checks and recover on the same run', t => {
  const p = workspace(t);
  p.write('src/queue.ts', 'export class Queue { #onEvent() {const listener = () => 1; return listener();} onIdle() {return this.#onEvent();} }');
  const verification = Array.from({length: 4}, (_, i) => ({command: 'node', args: ['--input-type=module', '-e',
    `import assert from 'node:assert/strict';import fs from 'node:fs';import {Queue} from './src/queue.ts';assert.equal(new Queue().onIdle(),1);fs.appendFileSync('executions.txt','${i}');`]}));
  p.write('terse.config.json', JSON.stringify({exclude: ['test'], verification}));
  p.write('executions.txt', '');
  const begun = p.run(['begin', '--task', 'Extract the event waiter and preserve its behavior', '--query', 'Queue onEvent']);
  const candidate = begun.context.candidates.find(item => item.symbol === 'Queue.#onEvent');
  assert(begun.decisionGuide.removalGuide);
  const saved = p.run(['decide', '--run', begun.run, '--strategy', 'refactor', '--rationale', 'Extract the existing implementation.', '--candidate', candidate.candidateId]);
  // Valid before editing: do not blanket-reject an empty list for all refactors.
  assert.deepEqual(saved.decision.remove, []);
  p.write('src/queue.ts', 'import {waitForEvent} from "./wait.ts"; export class Queue {onIdle() {return waitForEvent();}}');
  p.write('src/wait.ts', 'export function waitForEvent() {return 1;}');
  const input = {...saved.decision, note: 'Preserve extension fields and candidate reasons.'};
  for (const strategy of ['refactor', 'modify', 'reuse', 'new']) {
    input.strategy = strategy;p.write('input.json', JSON.stringify(input));
    p.run(['decide', '--run', begun.run, '--input', 'input.json']);
    const report = p.run(['check', '--run', begun.run, '--summary'], 1);
    assert.equal(report.status, 'fail');assert.equal(report.verification.length, 4);
    assert(report.verification.every(item => item.status === 'passed' && item.outputOmitted), JSON.stringify(report.verification));
    assert.deepEqual(report.undeclaredRemovals, [{path: 'src/queue.ts', symbol: 'Queue.#onEvent'}]);
    assert(report.findings.some(item => item.rule === 'REMOVAL_DECLARATION_MISSING' && item.severity === 'fail'));
    assert(report.findings.some(item => item.rule === 'REMOVAL_REFERENCE_UNCERTAIN'));
    const stored = JSON.parse(fs.readFileSync(report.reportPath, 'utf8'));
    assert.deepEqual(stored.undeclaredRemovals, report.undeclaredRemovals);assert.deepEqual(stored.findings, report.findings);
    assert.deepEqual(JSON.parse(fs.readFileSync(saved.decisionPath, 'utf8')).remove, []);
  }
  assert.equal(fs.readFileSync(path.join(p.root, 'executions.txt'), 'utf8'), '0123'.repeat(4));
  input.remove = [{path: 'src/queue.ts', symbol: 'Queue.#onEvent'}];p.write('input.json', JSON.stringify(input));
  const updated = p.run(['decide', '--run', begun.run, '--input', 'input.json']);
  assert.deepEqual(updated.decision, input);
  const corrected = p.run(['check', '--run', begun.run, '--summary'], 2);
  assert.deepEqual(corrected.undeclaredRemovals, []);
  assert.deepEqual(corrected.findings.map(item => item.rule), ['REMOVAL_REFERENCE_UNCERTAIN']);
  assert(corrected.verification.every(item => item.status === 'passed'));
  assert.equal(fs.readFileSync(path.join(p.root, 'executions.txt'), 'utf8'), '0123'.repeat(5));
  const full = p.run(['check', '--run', begun.run], 2);
  assert.deepEqual(full.findings, corrected.findings);assert.deepEqual(full.undeclaredRemovals, corrected.undeclaredRemovals);
});

test('M5 file omissions expose stale imports; unrelated or partial declarations cannot hide them', t => {
  const p = workspace(t);
  p.write('src/old.ts', 'export function old() {return 1;}');
  p.write('src/other.ts', 'export function other() {return 2;}');
  p.write('src/use.ts', 'import {old} from "./old.js"; export function use() {return old();}');
  const begun = p.run(['begin', '--task', 'Retire obsolete modules', '--query', 'old other']);
  const input = {strategy: 'refactor', rationale: 'Retire these modules.', considered: [{path: 'src/old.ts', symbol: 'old', disposition: 'modify', reason: 'Retire old owner.'}], remove: []};
  p.write('input.json', JSON.stringify(input));p.run(['decide', '--run', begun.run, '--input', 'input.json']);
  fs.unlinkSync(path.join(p.root, 'src/old.ts'));fs.unlinkSync(path.join(p.root, 'src/other.ts'));
  const omitted = p.run(['check', '--run', begun.run], 1);
  assert.deepEqual(omitted.undeclaredRemovals, [{path: 'src/old.ts'}, {path: 'src/other.ts'}]);
  assert(omitted.findings.some(item => item.rule === 'REMOVAL_REFERENCE_REMAINS'));
  input.remove = [{path: 'src/old.ts'}];p.write('input.json', JSON.stringify(input));p.run(['decide', '--run', begun.run, '--input', 'input.json']);
  assert.deepEqual(p.run(['check', '--run', begun.run], 1).undeclaredRemovals, [{path: 'src/other.ts'}]);
  // --input replaces the whole record: accidentally dropping old must be caught.
  input.remove = [{path: 'src/other.ts'}];p.write('input.json', JSON.stringify(input));p.run(['decide', '--run', begun.run, '--input', 'input.json']);
  assert.deepEqual(p.run(['check', '--run', begun.run], 1).undeclaredRemovals, [{path: 'src/old.ts'}]);
  input.remove.push({path: 'src/old.ts'});p.write('input.json', JSON.stringify(input));p.run(['decide', '--run', begun.run, '--input', 'input.json']);
  p.write('src/use.ts', 'export function use() {return 1;}');
  assert.equal(p.run(['check', '--run', begun.run]).status, 'pass');
});

test('M5 in-place refactors and reasonable new work may keep empty removals', t => {
  const p = workspace(t);
  const begun = p.run(['begin', '--task', 'Improve the existing export', '--query', 'exportOrders']);
  const candidate = begun.context.candidates.find(item => item.symbol === 'exportOrders');
  p.run(['decide', '--run', begun.run, '--strategy', 'refactor', '--rationale', 'Keep the existing declaration.', '--candidate', candidate.candidateId]);
  p.write('src/orders.ts', '// Improve readability without retiring a declaration.\n' + fs.readFileSync(path.join(p.root, 'src/orders.ts'), 'utf8'));
  p.write('src/new.ts', 'export function independent() {return "separate";}');
  assert.deepEqual(p.run(['check', '--run', begun.run]).undeclaredRemovals, []);
});

test('p-queue historical refactor patches now expose their omitted declaration without rewriting evidence', async t => {
  const directory = new URL('../benchmarks/skill/p-queue-observed/', import.meta.url);
  const report = JSON.parse(fs.readFileSync(new URL('report.json', directory), 'utf8'));
  const archive = JSON.parse(gunzipSync(fs.readFileSync(new URL(`../fixtures/${report.terseRevision}.json.gz`, directory))).toString('utf8'));
  const p = workspace(t), project = path.join(p.root, 'replay');fs.mkdirSync(project);
  for (const result of report.results.filter(item => item.taskId === 'refactor')) await t.test(result.artifactId, () => {
    const target = path.join(project, result.artifactId);fs.mkdirSync(target);
    for (const [file, content] of Object.entries(archive.upstreamInputs.files)) {
      const location = path.join(target, file);fs.mkdirSync(path.dirname(location), {recursive: true});fs.writeFileSync(location, content.replaceAll('\r\n', '\n'));
    }
    execFileSync('git', ['init', '-q'], {cwd: target});execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '.'], {cwd: target, stdio: 'pipe'});
    const before = state(Object.fromEntries(Object.entries(archive.upstreamInputs.files).filter(([file]) => file.startsWith('source/'))));
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--', fileURLToPath(new URL(result.patch, directory))], {cwd: target, stdio: 'pipe'});
    const sources = Object.fromEntries(fs.readdirSync(path.join(target, 'source')).map(file => [`source/${file}`, fs.readFileSync(path.join(target, 'source', file), 'utf8')]));
    assert.deepEqual(missing(before, state(sources)), [{path: 'source/index.ts', symbol: 'PQueue.#onEvent'}]);
    assert.deepEqual(missing(before, state(sources), [{path: 'source/index.ts', symbol: 'PQueue.#onEvent'}]), []);
    assert.equal(result.workflow.completed, false); // Historical observation stays 4/6 overall.
  });
});
