import PQueue from './project/source/index.js';
import {waitForEvent} from './project/source/wait-for-event.js';
import {EventEmitter} from './project/node_modules/eventemitter3/index.js';
const emitter = new EventEmitter();
const ready: Promise<void> = waitForEvent(emitter, 'ready', () => true);
// @ts-expect-error filter must be callable when supplied.
waitForEvent(emitter, 'ready', true);
const idle: Promise<void> = new PQueue().onIdle();
void ready; void idle;
