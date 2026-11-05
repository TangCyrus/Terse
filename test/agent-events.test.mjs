import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { summarizeEvents, pairedSummary } from '../scripts/lib/agent-events.mjs';

test('agent events retain real usage, transport failures and final completion separately', () => {
  const result = summarizeEvents([
    {type: 'error', message: 'Reconnecting'},
    {type: 'item.completed', item: {type: 'command_execution'}},
    {type: 'item.completed', item: {type: 'agent_message', text: 'Done'}},
    {type: 'turn.completed', usage: {input_tokens: 120, cached_input_tokens: 80, output_tokens: 12}},
  ].map(event => JSON.stringify(event)).join('\n'));
  assert.equal(result.completed, true);
  assert.deepEqual(result.usage, {input_tokens: 120, cached_input_tokens: 80, output_tokens: 12});
  assert.deepEqual(result.errors, ['Reconnecting']);
  assert.equal(result.commandCount, 1);
  assert.equal(result.finalMessage, 'Done');
});

test('missing, truncated and failed agent turns cannot be counted as completed runs', () => {
  for (const text of ['', 'null', '12', '{"type":"turn.started"}', '{"type":"turn.completed"}\n{broken', '{"type":"turn.completed"}\n{"type":"turn.failed"}']) {
    assert.equal(summarizeEvents(text).completed, false);
  }
  assert.equal(summarizeEvents('').usage, null);
  assert.equal(summarizeEvents('{"type":"turn.completed"}').usage, null);
});

test('agent comparison keeps incomplete or invalid pairs out of elapsed-time differences', () => {
  const control = {repetition: 1, arm: 'control', baselineHash: 'same', acceptanceHash: 'tests', protocolValid: true, agentMs: 100, correct: true, newDuplications: 2};
  const terse = {...control, arm: 'terse', agentMs: 140, newDuplications: 0};
  assert.equal(pairedSummary([control])[0].comparable, false);
  assert.equal(pairedSummary([control, terse])[0].terseMinusControlMs, 40);
  for (const invalid of [{...terse, protocolValid: false}, {...terse, baselineHash: 'changed'}, {...terse, acceptanceHash: 'different'}, {...terse, newDuplications: null}]) {
    assert.equal(pairedSummary([control, invalid])[0].terseMinusControlMs, null);
  }
});

test('published agent results bind task, tests, dependency lock and implementation patches', () => {
  const directory = new URL('../benchmarks/p-map/', import.meta.url);
  const read = file => fs.readFileSync(new URL(file, directory));
  const hash = value => createHash('sha256').update(value).digest('hex');
  const report = JSON.parse(read('observed/comparison.json'));
  assert.deepEqual(report.project, JSON.parse(read('project.json')));
  assert.equal(report.taskHash, hash(read('task.md')));
  assert.equal(report.acceptanceHash, hash(read('acceptance.mjs')));
  assert.equal(report.typeAcceptanceHash, hash(read('acceptance-types.mts')));
  assert.equal(report.dependencyLockHash, hash(gunzipSync(read('observed/dependency-lock.json.gz'))));
  assert.equal(report.results.length, report.repetitions * 2);
  assert.deepEqual(report.pairs, pairedSummary(report.results));
  for (const run of report.results) {
    assert.equal(hash(read(`observed/${run.patch}`)), run.evidence.patchHash);
    const findings = JSON.parse(read(`observed/${run.duplications}`));
    assert.equal(findings.length, run.newDuplications);
    assert.equal(run.correct, Object.values(run.checks).every(check => check.passed) && run.tampered.length === 0);
    assert(!Object.hasOwn(run.events, 'finalMessage'));
  }
  assert(!Object.hasOwn(report, 'artifactDirectory'));
});
