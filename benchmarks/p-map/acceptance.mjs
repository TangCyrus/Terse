import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const api = await import(pathToFileURL(path.join(process.cwd(), 'index.js')));
const settled = (...args) => {
  assert.equal(typeof api.pMapSettled, 'function', 'pMapSettled must be exported');
  return api.pMapSettled(...args);
};

test('ordered mapper outcomes retain rejection identity and original indexes', async () => {
  const rejection = new Error('expected mapper failure');
  const indexes = [];
  const output = await settled([Promise.resolve(3), 2, 1], async (value, index) => {
    indexes.push(index);
    await delay(value);
    if (value === 2) throw rejection;
    return value * 2;
  }, { concurrency: 2, stopOnError: true });
  assert.deepEqual(output, [{ status: 'fulfilled', value: 6 }, { status: 'rejected', reason: rejection }, { status: 'fulfilled', value: 2 }]);
  assert.deepEqual(indexes.sort(), [0, 1, 2]);
});

test('concurrency is bounded and both synchronous throws and async rejections settle', async () => {
  let active = 0, peak = 0;
  const outcomes = await settled([1, 2, 3, 4], async value => {
    active++; peak = Math.max(peak, active);
    await delay(2);
    active--;
    if (value % 2 === 0) throw value;
    return value;
  }, { concurrency: 2 });
  assert.equal(peak, 2);
  assert.deepEqual(outcomes.map(item => item.status), ['fulfilled', 'rejected', 'fulfilled', 'rejected']);
  assert.deepEqual(await settled([1, 2], value => { if (value === 1) throw 'sync'; return value; }),
    [{ status: 'rejected', reason: 'sync' }, { status: 'fulfilled', value: 2 }]);
});

test('async input, empty input and skip retain existing conventions', async () => {
  async function* values() { yield 1; yield 2; yield 3; }
  assert.deepEqual(await settled(values(), value => value === 2 ? api.pMapSkip : value, { concurrency: 1 }),
    [{ status: 'fulfilled', value: 1 }, { status: 'fulfilled', value: 3 }]);
  assert.deepEqual(await settled([], value => value), []);
});

test('argument and iterator errors reject rather than becoming mapper records', async () => {
  for (const args of [[{}, value => value], [[1], null], [[1], value => value, { concurrency: 0 }]]) {
    await assert.rejects(async () => settled(...args), TypeError);
  }
  const reason = new Error('source failed');
  async function* broken() { yield 1; throw reason; }
  await assert.rejects(async () => settled(broken(), value => value, { concurrency: 1 }), error => error === reason);
});

test('abort rejects with the signal reason and preserves the original API', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel');
  controller.abort(reason);
  await assert.rejects(async () => settled([1], value => value, { signal: controller.signal }), error => error === reason);
  assert.deepEqual(await api.default([1, 2], value => value * 3), [3, 6]);
  await assert.rejects(api.default([1], () => Promise.reject(reason)), error => error === reason);
  const output = [];
  for await (const value of api.pMapIterable([1, 2], value => value + 1, { concurrency: 1 })) output.push(value);
  assert.deepEqual(output, [2, 3]);
});
