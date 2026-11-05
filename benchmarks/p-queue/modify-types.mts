import PQueue from './project/source/index.js';
const queue = new PQueue();
const empty: Promise<void> = queue.onEmpty({signal: new AbortController().signal});
const idle: Promise<void> = queue.onIdle({});
const legacy: Promise<void> = queue.onIdle();
// @ts-expect-error signal is an AbortSignal.
queue.onIdle({signal: 'cancel'});
// @ts-expect-error options must be an object.
queue.onEmpty('cancel');
void empty; void idle; void legacy;
