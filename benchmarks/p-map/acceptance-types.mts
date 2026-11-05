import {pMapSettled, pMapSkip} from './project/index.js';

const outcomes: Promise<Array<PromiseSettledResult<string>>> = pMapSettled([1, 2], async (value, index) => index ? pMapSkip : String(value));
const asyncInput: AsyncIterable<number> = (async function* () { yield 1; })();
const numeric: Promise<Array<PromiseSettledResult<number>>> = pMapSettled(asyncInput, value => value * 2, {concurrency: 2, signal: new AbortController().signal});
// @ts-expect-error A mapper is required.
pMapSettled([1]);
// @ts-expect-error Concurrency must be numeric.
pMapSettled([1], value => value, {concurrency: '2'});
void outcomes;
void numeric;
