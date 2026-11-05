Implement a named export `pMapSettled(input, mapper, options?)` in this version of p-map, with TypeScript declarations and a short README example. Preserve all existing public behavior.

The new API has these requirements:

- Accept the synchronous/asynchronous inputs, fulfilled promised values, mapper(value, index), concurrency and signal behavior supported by pMap.
- Return ordered records `{status: 'fulfilled', value}` or `{status: 'rejected', reason}` for mapper outcomes. A mapper throwing synchronously or rejecting asynchronously produces a rejected record without cancelling later items. Ignore stopOnError for mapper outcomes.
- Keep pMapSkip behavior: a mapper returning pMapSkip omits that item, rather than producing a fulfilled record containing the symbol.
- Invalid input/mapper/concurrency, iteration failures and aborts still reject the returned promise. Rejected input promises are outside this task's acceptance scope.
- Empty input resolves to an empty array. Existing pMap and pMapIterable semantics must remain intact.

Only edit index.js, index.d.ts and readme.md. Do not change tests, dependencies, project configuration or benchmark files. Do not commit or push. Do not read other experiment directories, use other agents, or search the web for an implementation. Use the existing installed dependencies. A useful independent acceptance command and upstream test command are supplied with this task. Run them and report any remaining failures truthfully. The experiment has a fixed time limit, and the evaluator will independently re-run the unchanged tests after you finish.
