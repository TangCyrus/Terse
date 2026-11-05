import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root, PQueue, EventEmitter, load, ast, nodes, ts, deferred, within } from './support.mjs';

test('public waiters delegate to the new module with the old private path removed', async () => {
  assert(fs.existsSync(path.join(root, 'source/wait-for-event.ts')));
  assert.equal(typeof (await load('wait-for-event.ts')).waitForEvent, 'function');
  const tree = ast('index.ts');
  assert(!nodes(tree).some(node => ts.isPrivateIdentifier(node) && node.text === '#onEvent'));
  const imports = tree.statements.filter(ts.isImportDeclaration).filter(node => /\/wait-for-event\.js$/.test(node.moduleSpecifier.text));
  const names = imports.flatMap(node => node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    ? node.importClause.namedBindings.elements.filter(item => (item.propertyName ?? item.name).text === 'waitForEvent').map(item => item.name.text) : []);
  const declaration = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'PQueue');
  for (const method of ['onEmpty', 'onIdle', 'onSizeLessThan']) {
    const member = declaration.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === method);
    assert(member && nodes(member).some(node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.includes(node.expression.text)), `${method} must delegate`);
  }
});

test('extracted helper preserves filters and unrelated EventEmitter3 listeners', async () => {
  const {waitForEvent} = await load('wait-for-event.ts');
  const emitter = new EventEmitter();
  let ready = false, otherCalls = 0;
  const other = () => { otherCalls++; };
  emitter.on('ready', other);
  const waiting = waitForEvent(emitter, 'ready', () => ready);
  emitter.emit('ready');
  assert.equal(emitter.listenerCount('ready'), 2);
  ready = true;
  emitter.emit('ready');
  await within(waiting);
  assert.deepEqual(emitter.listeners('ready'), [other]);
  emitter.emit('ready');
  assert.equal(otherCalls, 3);
});

test('onEmpty and onIdle keep distinct queue-versus-running semantics', async t => {
  const queue = new PQueue({concurrency: 2, autoStart: false});
  const first = deferred(), second = deferred();
  const jobs = [queue.add(() => first.promise), queue.add(() => second.promise)];
  t.after(async () => { first.resolve(); second.resolve(); await Promise.all(jobs); });
  const empty = queue.onEmpty();
  let idle = false;
  const completed = queue.onIdle().then(() => { idle = true; });
  queue.start();
  await within(empty);
  assert.equal(queue.pending, 2);
  first.resolve();
  await jobs[0];
  assert.equal(queue.pending, 1);
  assert.equal(idle, false);
  second.resolve();
  await within(completed);
  assert.equal(queue.pending, 0);
});

test('onSizeLessThan keeps its filter and does not count running work', async t => {
  const queue = new PQueue({concurrency: 1, autoStart: false});
  const first = deferred(), second = deferred();
  const jobs = [queue.add(() => first.promise), queue.add(() => second.promise)];
  t.after(async () => { queue.start(); first.resolve(); second.resolve(); await Promise.all(jobs); });
  const other = () => {};
  queue.on('next', other);
  let below = false;
  const waiting = queue.onSizeLessThan(1).then(() => { below = true; });
  queue.start();
  await Promise.resolve();
  assert.equal(queue.size, 1);
  assert.equal(below, false);
  first.resolve();
  await within(waiting);
  assert.equal(queue.pending, 1);
  assert.deepEqual(queue.listeners('next'), [other]);
  second.resolve();
  await queue.onIdle();
});
