import PQueue from './project/source/index.js';
import PriorityQueue from './project/source/priority-queue.js';
const queue = new PriorityQueue();
queue.enqueue(async () => 1, {priority: 3});
const jobs: Array<() => Promise<unknown>> = queue.filter({priority: 3});
const job: (() => Promise<unknown>) | undefined = queue.dequeue();
// @ts-expect-error Priority remains numeric.
queue.enqueue(async () => 1, {priority: '3'});
const idle: Promise<void> = new PQueue().onIdle();
void jobs; void job; void idle;
