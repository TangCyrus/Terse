// Loaded by the host test runner, outside the candidate project. Candidate stdout
// stays inside test:stdout events and cannot masquerade as reporter records.
export default async function* (source) {
  for await (const {type, data} of source) {
    yield JSON.stringify({type, data}, (_key, value) => value instanceof Error
      ? {message: value.message, stack: value.stack, ...value} : value) + '\n';
  }
  yield JSON.stringify({type: 'terse:reporter-complete'}) + '\n';
}
