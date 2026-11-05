import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root, PQueue, load, ast, nodes, ts } from './support.mjs';

test('the retired source module and static module references are absent', () => {
  assert(!fs.existsSync(path.join(root, 'source/lower-bound.ts')), 'Delete the old module, including empty stubs');
  for (const file of fs.readdirSync(path.join(root, 'source')).filter(file => file.endsWith('.ts'))) {
    for (const node of nodes(ast(file))) {
      const expression = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === 'require') ? node.arguments[0] : undefined;
      if (expression && ts.isStringLiteralLike(expression)) assert(!/(?:^|\/)lower-bound(?:\.[jt]s)?$/.test(expression.text), `${file}: obsolete import`);
    }
  }
});

test('public priority ordering stays descending and FIFO for ties', async () => {
  const queue = new PQueue({concurrency: 1, autoStart: false});
  const order = [];
  const priorities = [1, 5, 3, 5, 0, 3];
  const jobs = priorities.map((priority, index) => queue.add(() => { order.push(index); return index; }, {priority}));
  queue.start();
  await Promise.all(jobs);
  assert.deepEqual(order, [1, 3, 2, 5, 0, 4]);
  await queue.onIdle();
});
test('insertion retains logarithmic comparison work rather than repeated sort or scan', async () => {
  const PriorityQueue = (await load('priority-queue.ts')).default;
  const queue = new PriorityQueue();
  let seed = 7, comparisons = 0;
  const entries = [];
  for (let index = 0; index < 300; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const priority = seed % 257;
    entries.push({index, priority});
    queue.enqueue(async () => index, {priority: {[Symbol.toPrimitive]() { comparisons++; return priority; }}});
  }
  assert(comparisons < 300 * 32, `Excessive comparison work: ${comparisons}`);
  const expected = entries.toSorted((a, b) => b.priority - a.priority || a.index - b.index).map(entry => entry.index);
  const actual = [];
  while (queue.size) actual.push(await queue.dequeue()());
  assert.deepEqual(actual, expected);
});

test('queue filtering and empty dequeue retain their contract', async () => {
  const PriorityQueue = (await load('priority-queue.ts')).default;
  const queue = new PriorityQueue();
  queue.enqueue(async () => 'low', {priority: -2});
  queue.enqueue(async () => 'a', {priority: 3});
  queue.enqueue(async () => 'b', {priority: 3});
  assert.deepEqual(await Promise.all(queue.filter({priority: 3}).map(run => run())), ['a', 'b']);
  assert.equal(queue.size, 3);
  for (let i = 0; i < 3; i++) queue.dequeue();
  assert.equal(queue.dequeue(), undefined);
});
