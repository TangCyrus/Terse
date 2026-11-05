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
  for (const recorded of ['observed', 'commands-observed']) {
    const report = JSON.parse(read(`${recorded}/comparison.json`));
    assert.deepEqual(report.project, JSON.parse(read('project.json')));
    assert.equal(report.taskHash, hash(read('task.md')));
    assert.equal(report.acceptanceHash, hash(read('acceptance.mjs')));
    assert.equal(report.typeAcceptanceHash, hash(read('acceptance-types.mts')));
    assert.equal(report.dependencyLockHash, hash(gunzipSync(read(`${recorded}/dependency-lock.json.gz`))));
    assert.equal(report.results.length, report.repetitions * 2);
    assert.deepEqual(report.pairs, pairedSummary(report.results));
    for (const run of report.results) {
      assert.equal(hash(read(`${recorded}/${run.patch}`)), run.evidence.patchHash);
      const findings = JSON.parse(read(`${recorded}/${run.duplications}`));
      assert.equal(findings.length, run.newDuplications);
      assert.equal(run.correct, Object.values(run.checks).every(check => check.passed) && run.tampered.length === 0);
      assert(!Object.hasOwn(run.events, 'finalMessage'));
    }
    assert(!Object.hasOwn(report, 'artifactDirectory'));
  }
});

test('multi-task agent pairs never combine different tasks with the same repetition', () => {
  const base = {repetition: 1, baselineHash: 'same', acceptanceHash: 'same', protocolValid: true, agentMs: 10, correct: true, newDuplications: 0};
  const runs = [{...base, taskId: 'modify', arm: 'control'}, {...base, taskId: 'delete', arm: 'terse'},
    {...base, taskId: 'modify', arm: 'terse', agentMs: 20}];
  assert.deepEqual(pairedSummary(runs), [
    {taskId: 'modify', repetition: 1, comparable: true, correctness: {control: true, terse: true},
      duplicateGroups: {control: 0, terse: 0}, agentMs: {control: 10, terse: 20}, terseMinusControlMs: 10},
    {taskId: 'delete', repetition: 1, comparable: false, reason: 'Missing arm'},
  ]);
});

test('published p-queue experiment binds every task, shared oracle, lock and new/deleted file patch', () => {
  const directory = new URL('../benchmarks/p-queue/', import.meta.url);
  const read = file => fs.readFileSync(new URL(file, directory));
  const hash = value => createHash('sha256').update(value).digest('hex');
  const report = JSON.parse(read('observed/comparison.json'));
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.project, JSON.parse(read('project.json')));
  assert.equal(report.dependencyLockHash, hash(gunzipSync(read('observed/dependency-lock.json.gz'))));
  assert.equal(report.results.length, report.tasks.length * report.repetitions * 2);
  assert.deepEqual(report.pairs, pairedSummary(report.results));
  assert.equal(report.preparation.kind, 'equivalent-flat-tsconfig');
  assert.equal(report.preparation.configuration.compilerOptions.strict, true);
  assert.equal(report.preflight.upstream.passed, true);
  assert.equal(report.preflight.build.passed, true);
  for (const task of report.tasks) {
    assert.equal(task.taskHash, hash(read(task.taskFile)));
    assert.equal(task.typeAcceptanceHash, hash(read(task.typeAcceptance)));
    const hashes = Object.fromEntries([task.acceptance, 'support.mjs'].sort().map(file => [file, hash(read(file))]));
    assert.deepEqual(task.acceptanceHashes, hashes);
    assert.equal(task.acceptanceHash, hash(JSON.stringify(hashes)));
    assert.equal(report.preflight.tasks.find(item => item.id === task.id).before.passed, false);
    for (const arm of ['control', 'terse']) {
      const runs = report.results.filter(run => run.taskId === task.id && run.arm === arm);
      assert.deepEqual(runs.map(run => run.repetition), [1, 2]);
      for (const run of runs) {
        assert.equal(run.acceptanceHash, task.acceptanceHash);
        assert.equal(hash(read(`observed/${run.patch}`)), run.evidence.patchHash);
        const patch = read(`observed/${run.patch}`).toString('utf8');
        for (const file of run.changed) assert(patch.includes(`diff --git a/${file} b/${file}`), `${run.artifactId}: missing patch for ${file}`);
        if (run.duplications) assert.equal(JSON.parse(read(`observed/${run.duplications}`)).length, run.newDuplications);
        else assert.equal(run.newDuplications, null);
        assert.equal(run.correct, Object.values(run.checks).every(check => check.passed) && run.tampered.length === 0);
        assert.equal(run.checks.upstream.passed, run.checks.upstream.exitCode === 0 && !run.checks.upstream.error
          && JSON.stringify(run.checks.upstream.counts) === JSON.stringify(report.project.upstreamCounts));
        assert(!Object.hasOwn(run.events, 'finalMessage'));
      }
    }
  }
  assert(!Object.hasOwn(report, 'artifactDirectory'));
});
