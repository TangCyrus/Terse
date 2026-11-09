import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {cleanupFindings} from '../dist/cleanup.js';
import {indexSources} from '../dist/analyze.js';
import {digest, parseConfig} from '../dist/project.js';
import {createWorkspace, invoke} from '../scripts/lib/workspace.mjs';

const target = {path: 'queue.ts', symbol: 'Queue.#onEvent'};
const baseline = 'export class Queue { #onEvent() {return 1;} onIdle() {return this.#onEvent();} }';
const state = (files, skipped = []) => ({files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, {content, hash: digest(content)}])),
  metadata: {}, config: parseConfig({}), skipped, hash: 'cleanup unit snapshot'});
function findings(source, {before = baseline, targets = [target], oldFiles = {}, files = {}, skipped = []} = {}) {
  const old = state({'queue.ts': before, ...oldFiles}), current = state({...(source === null ? {} : {'queue.ts': source}), ...files}, skipped);
  const oldIndex = indexSources(old), currentIndex = indexSources(current, undefined, old.files);
  assert.deepEqual(oldIndex.errors, []);assert.deepEqual(currentIndex.errors, []);
  return cleanupFindings(old, current, oldIndex, currentIndex, targets);
}

test('confirmed #private cleanup ignores unrelated imports, strings, property spellings and other private owners', async t => {
  const clean = [
    'export class Queue {onIdle() {return waitForEvent(this);}} function waitForEvent(queue) {return 1;}',
    'export class Queue {onIdle() {return "this.#onEvent()";}} // this.#onEvent()',
    'export class Queue {["#onEvent"]() {return 1;} onIdle() {return this["#onEvent"]();}}',
    'export class Queue {} class Other {#onEvent() {} run() {return this.#onEvent();}}',
    'export class Queue {} class Derived extends Queue {#onEvent() {} run() {return this.#onEvent();}}',
    'export class Queue {run(code) {return (0, eval)(code);}}',
    'export class Queue {run(code) {return eval?.(code);}}',
  ];
  for (const [i, source] of clean.entries()) await t.test(`clean ${i}`, () => assert.deepEqual(findings(source, {
    oldFiles: {'use.ts': 'import {Queue} from "./queue.js"; export const queue = new Queue();'},
    files: {'use.ts': 'import {Queue} from "./queue.js"; export const queue = new Queue();', 'dynamic.ts': 'export const plugin = import(selected);'},
  }), []));
});

test('remaining lexical private reads, calls, brand checks and closures fail independent of receiver typing', async t => {
  const stale = [
    'return this.#onEvent();', 'return this.#onEvent?.();', 'return this.#onEvent;',
    'return this.#onEvent.bind(this);', 'return #onEvent in value;', 'return () => this.#onEvent();',
    'function nested(receiver) {return receiver.#onEvent();} return nested;',
    'const alias = this; return alias.#onEvent();', 'return value.#onEvent;',
    'return class Inner {run(receiver) {return receiver.#onEvent();}};',
    'return class Inner extends (this.#onEvent(), Object) {#onEvent() {}};',
  ];
  for (const [i, body] of stale.entries()) await t.test(`stale ${i}`, () => {
    const result = findings(`export class Queue {run(value) {${body}}}`);
    assert(result.some(item => item.rule === 'REMOVAL_REFERENCE_REMAINS' && item.severity === 'fail'));
    assert(result.every(item => item.locations[0].path === 'queue.ts' && item.locations[0].symbol === target.symbol && item.locations[0].line >= 1));
  });
});

test('nested classes shadow only their own member private environment, including fields, accessors and same class names', async t => {
  for (const declaration of ['#onEvent() {}', '#onEvent = () => 1;', 'get #onEvent() {return 1;}', 'static #onEvent() {}']) {
    await t.test(declaration, () => assert.deepEqual(findings(`export class Queue {run() {return class Queue {${declaration} run(value) {return value.#onEvent;}};}}`), []));
  }
  assert(findings('export class Queue {run() {return class Inner extends eval(code) {#onEvent() {}};}}')
    .some(item => item.rule === 'REMOVAL_REFERENCE_UNCERTAIN'));
  assert.deepEqual(findings('export class Queue {run() {return class Inner {#onEvent() {} run(code) {return eval(code);}};}}'), []);
});

test('retaining the private name as any class element is a removal failure', async t => {
  for (const declaration of ['#onEvent() {}', '#onEvent = () => 1;', 'get #onEvent() {return 1;}', 'static #onEvent = 1;']) {
    await t.test(declaration, () => assert.deepEqual(findings(`export class Queue {${declaration}}`).map(item => [item.rule, item.severity]), [['REMOVAL_REMAINS', 'fail']]));
  }
});

test('direct eval, ambiguous or changed owner scope, ambient and decorated syntax retain review', async t => {
  for (const expression of ['eval(code)', '(eval)(code)', '(eval as any)(code)', 'eval!(code)', '(eval satisfies Function)(code)']) {
    await t.test(expression, () => assert(findings(`export class Queue {run(code) {return ${expression};}}`)
      .some(item => item.rule === 'REMOVAL_REFERENCE_UNCERTAIN' && item.severity === 'review')));
  }
  for (const source of ['export class Renamed {}', 'export class Queue {} class Queue {}', 'export declare class Queue {}',
    '@decorate export class Queue {}', 'export class Queue {@decorate run() {}}']) {
    assert(findings(source).some(item => item.rule === 'REMOVAL_REFERENCE_UNCERTAIN'));
  }
  const nested = 'function create() {class Queue {#onEvent() {}} return Queue;}';
  assert(findings('function create() {class Queue {} return Queue;}', {before: nested}).some(item => item.rule === 'REMOVAL_REFERENCE_UNCERTAIN'));
  const ambiguous = baseline + ' function make() {class Queue {#onEvent() {}} return Queue;}';
  assert(findings('export class Queue {}', {before: ambiguous}).some(item => item.rule === 'REMOVAL_REFERENCE_UNCERTAIN'));
});

test('private proof does not clear public/TS-private uncertainty, coverage gaps or other removal targets', () => {
  for (const modifier of ['', 'private ']) {
    assert(findings('export class Queue {}', {before: `export class Queue {${modifier}onEvent() {}}`, targets: [{path: 'queue.ts', symbol: 'Queue.onEvent'}]})
      .some(item => item.rule === 'REMOVAL_REFERENCE_UNCERTAIN'));
  }
  assert(findings(null, {skipped: [{path: 'queue.ts', reason: 'over-1MiB'}]}).some(item => item.rule === 'REMOVAL_NOT_VERIFIED'));
  const mixed = findings('export class Queue {}', {oldFiles: {'old.ts': 'export function old() {}'},
    files: {'dynamic.ts': 'export const plugin = import(selected);'}, targets: [target, {path: 'old.ts'}]});
  assert(mixed.some(item => item.rule === 'REMOVAL_REFERENCE_UNRESOLVED'));
  const removedFile = findings(null, {files: {'use.ts': 'import {Queue} from "./queue.js"; new Queue();'}});
  assert(removedFile.some(item => item.rule === 'REMOVAL_REFERENCE_REMAINS'));
});

test('private names use decoded identifier identity rather than their source spelling', () => {
  const before = String.raw`export class Queue {#\u006fnEvent() {}}`;
  const oldIndex = indexSources(state({'queue.ts': before}));const escaped = oldIndex.symbols.find(item => item.symbol.includes('.#')).symbol;
  assert.deepEqual(findings('export class Queue {#onEvent = 1;}', {before, targets: [{path: 'queue.ts', symbol: escaped}]}).map(item => item.rule), ['REMOVAL_REMAINS']);
  assert(findings('export class Queue {run() {return this.#onEvent;}}', {before, targets: [{path: 'queue.ts', symbol: escaped}]})
    .some(item => item.rule === 'REMOVAL_REFERENCE_REMAINS'));
});

test('native JavaScript confirms private-name binding, nested heritage and direct-eval boundaries', () => {
  for (const code of ['class Queue {run() {return this.#onEvent;}}',
    'class Queue {run() {return class Inner extends (this.#onEvent(), Object) {#onEvent() {}};}}']) {
    assert.throws(() => new Function(code), SyntaxError);
  }
  assert.doesNotThrow(() => new Function('class Queue {run() {return class Inner {#onEvent() {} run() {return this.#onEvent();}};}}'));
  const Public = new Function('return class Queue {["#onEvent"]() {return 1;} run() {return this["#onEvent"]();}}')();
  assert.equal(new Public().run(), 1);
  const Dynamic = new Function('return class Queue {run() {return eval("this.#onEvent()");}}')();
  assert.throws(() => new Dynamic().run(), SyntaxError);
});

test('CLI fails definite private references, passes confirmed cleanup and retains direct-eval review with verification', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-private-cleanup-'));
  t.after(() => {
    const resolved = fs.realpathSync(parent);assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('terse-private-cleanup-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const root = createWorkspace(parent, 'project'), file = path.join(root, 'src/queue.ts');fs.writeFileSync(file, baseline);
  const begun = invoke(root, ['begin', '--task', 'Extract the old private waiter', '--query', 'Queue onEvent']);
  const candidate = begun.context.candidates.find(item => item.symbol === 'Queue.#onEvent');
  const decision = {strategy: 'refactor', rationale: 'Retire the private implementation and reuse a helper.', considered: [{path: candidate.path, symbol: candidate.symbol, disposition: 'modify', reason: 'Existing owner.'}],
    remove: [{path: 'src/queue.ts', symbol: 'Queue.#onEvent'}]};
  fs.writeFileSync(path.join(root, 'input.json'), JSON.stringify(decision));invoke(root, ['decide', '--run', begun.run, '--input', 'input.json']);
  fs.writeFileSync(file, 'export class Queue {onIdle() {return this.#onEvent();}}');
  const failed = invoke(root, ['check', '--run', begun.run, '--summary'], 1);
  assert(failed.findings.some(item => item.rule === 'REMOVAL_REFERENCE_REMAINS'));
  assert(failed.verification.every(item => item.status === 'passed'));
  fs.writeFileSync(file, 'export class Queue {onIdle() {return 1;}}');
  const clean = invoke(root, ['check', '--run', begun.run, '--summary']);assert.deepEqual(clean.findings, []);
  assert(clean.verification.every(item => item.status === 'passed'));
  fs.writeFileSync(file, 'export class Queue {onIdle(code) {return eval(code);}}');
  const uncertain = invoke(root, ['check', '--run', begun.run, '--summary'], 2);
  assert.deepEqual(uncertain.findings.map(item => item.rule), ['REMOVAL_REFERENCE_UNCERTAIN']);
  assert(uncertain.verification.every(item => item.status === 'passed'));
  assert.deepEqual(JSON.parse(fs.readFileSync(uncertain.reportPath, 'utf8')).findings, uncertain.findings);
});
