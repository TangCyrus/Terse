import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { PQueue, deferred, within } from './support.mjs';

test('already aborted signals reject even on immediately satisfied waits', async () => {
  const queue = new PQueue();
  const controller = new AbortController();
  const reason = new Error('already aborted');
  controller.abort(reason);
  for (const method of ['onEmpty', 'onIdle']) await assert.rejects(queue[method]({signal: controller.signal}), error => error === reason);
});

test('aborting onEmpty removes only its listeners and preserves queued work', async t => {
  const queue = new PQueue({autoStart: false});
  const controller = new AbortController();
  const job = queue.add(() => 42);
  t.after(async () => { queue.start(); await job; });
  const other = () => {};
  queue.on('empty', other);
  const pending = queue.onEmpty({signal: controller.signal});
  const reason = {cancelled: true};
  controller.abort(reason);
  await assert.rejects(within(pending), error => error === reason);
  assert.equal(queue.size, 1);
  assert.deepEqual(queue.listeners('empty'), [other]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('aborting one idle waiter neither cancels running work nor another waiter', async t => {
  const queue = new PQueue({concurrency: 1});
  const gate = deferred();
  const job = queue.add(() => gate.promise);
  t.after(async () => { gate.resolve('done'); await job; });
  const controller = new AbortController();
  const reason = new Error('cancel one wait');
  const cancelled = queue.onIdle({signal: controller.signal});
  const unaffected = queue.onIdle();
  controller.abort(reason);
  await assert.rejects(within(cancelled), error => error === reason);
  assert.equal(queue.pending, 1);
  gate.resolve('done');
  await within(unaffected);
  assert.equal(await job, 'done');
  assert.equal(queue.listenerCount('idle'), 0);
});

test('successful idle settlement removes signal and queue listeners', async t => {
  const queue = new PQueue();
  const gate = deferred();
  const job = queue.add(() => gate.promise);
  t.after(async () => { gate.resolve(); await job; });
  const controller = new AbortController();
  const idle = queue.onIdle({signal: controller.signal});
  assert(getEventListeners(controller.signal, 'abort').length > 0);
  gate.resolve();
  await within(idle);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(queue.listenerCount('idle'), 0);
  controller.abort();
  await queue.onIdle();
});

test('successful onEmpty still permits pending work and detaches abort listener', async t => {
  const queue = new PQueue({autoStart: false});
  const gate = deferred();
  const job = queue.add(() => gate.promise);
  t.after(async () => { gate.resolve(); await job; });
  const controller = new AbortController();
  const empty = queue.onEmpty({signal: controller.signal});
  queue.start();
  await within(empty);
  assert.equal(queue.pending, 1);
  assert.equal(queue.listenerCount('empty'), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
