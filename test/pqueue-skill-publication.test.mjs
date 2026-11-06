import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {hash, skillSummary, skillWorkflow} from '../scripts/lib/skill-evidence.mjs';
import {inScope} from '../scripts/lib/benchmark-project.mjs';
import {snapshot} from '../dist/project.js';
import {analyzeEvaluation} from '../scripts/lib/evaluation-project.mjs';

test('scoped check credit requires an unchanged start-to-completion interval', () => {
  const directory = fileURLToPath(new URL('../benchmarks/skill/p-queue-observed/', import.meta.url));
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
  const result = report.results.find(item => item.artifactId === 'modify-session-1');
  const original = JSON.parse(fs.readFileSync(path.join(directory, result.observations), 'utf8'));
  const options = {initialHash: result.baselineHash, finalHash: result.snapshotHash, verification: result.verification,
    initialScopeHash: result.initialScopeHash, finalScopeHash: result.finalScopeHash, editable: result.editable, traceComplete: true};
  const completed = original.findLast(item => item.responses.some(response => response.command === 'check'));
  const started = original.find(item => item.itemId === completed.itemId && item.event === 'item.started');
  assert.equal(skillWorkflow(original, options).completed, true);
  // check; edit README in the same command: its completion and final state
  // agree, but the state at command start was different and cannot be credited.
  const edited = structuredClone(original);
  for (const item of edited.filter(item => item.sequence >= completed.sequence)) item.scopeHash = 'after-docs';
  assert.equal(skillWorkflow(edited, {...options, finalScopeHash: 'after-docs'}).fullFinalCheck, false);
  assert.equal(skillWorkflow(original.filter(item => item !== started), options).fullFinalCheck, false);
  const wrongId = structuredClone(original);wrongId.find(item => item.sequence === started.sequence).itemId = 'unrelated';
  assert.equal(skillWorkflow(wrongId, options).fullFinalCheck, false);
  const intervening = structuredClone(original);
  intervening.splice(intervening.findIndex(item => item.sequence === completed.sequence), 0,
    {...structuredClone(started), sequence: started.sequence + 0.5, itemId: 'parallel-edit', scopeHash: 'temporary-docs'});
  assert.equal(skillWorkflow(intervening, options).fullFinalCheck, false);
  const recovered = structuredClone(edited);
  recovered.push({...structuredClone(started), sequence: original.at(-1).sequence + 1, itemId: 'recheck', scopeHash: 'after-docs'},
    {...structuredClone(completed), sequence: original.at(-1).sequence + 2, itemId: 'recheck', scopeHash: 'after-docs'});
  assert.equal(skillWorkflow(recovered, {...options, finalScopeHash: 'after-docs'}).completed, true);
});

test('p-queue Skill evidence preserves upstream, dependency lock, all sessions and offline source effects', async t => {
  const directory = fileURLToPath(new URL('../benchmarks/skill/p-queue-observed/', import.meta.url));
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
  const archive = JSON.parse(gunzipSync(fs.readFileSync(path.join(directory, '../fixtures', `${report.terseRevision}.json.gz`))).toString('utf8'));
  assert.equal(report.kind, 'agent-skill-integration');assert.equal(report.suite, 'p-queue');
  assert.equal(report.results.length, 6);assert.equal(report.repetitions, 2);
  assert.equal(report.upstream.commit, '47a4f19ab3d4422e06cb1b618f4c45a11b5def30');
  assert.equal(archive.revision, report.terseRevision);assert.equal(archive.schemaVersion, 1);
  assert.deepEqual(Object.keys(archive.files).sort(), Object.keys(report.fixtureHashes).sort());
  for (const [file, input] of Object.entries(archive.files)) {
    assert.equal(hash(input), report.fixtureHashes[file], file);
    assert.equal(hash(input.replaceAll('\r\n', '\n')), report.fixtureCanonicalHashes[file], file);
  }
  const upstream = archive.upstreamInputs;
  assert.deepEqual(Object.keys(upstream.files).sort(), Object.keys(report.upstream.sourceHashes).sort());
  for (const [file, input] of Object.entries(upstream.files)) assert.equal(hash(input), report.upstream.sourceHashes[file], file);
  assert.equal(hash(upstream.dependencyLock), report.upstream.dependencyLockHash);
  const oldLock = gunzipSync(fs.readFileSync(new URL('../benchmarks/p-queue/optimized-observed/dependency-lock.json.gz', import.meta.url)));
  assert.equal(hash(oldLock), report.upstream.dependencyLockHash);
  assert.equal(fs.readFileSync(path.join(directory, 'LICENSE'), 'utf8'), upstream.files.license);
  assert.deepEqual(Object.keys(archive.publicationHashes).sort(), fs.readdirSync(directory).sort());
  assert.equal(fs.readdirSync(directory).length, 21);
  for (const [file, expected] of Object.entries(archive.publicationHashes)) assert.equal(hash(fs.readFileSync(path.join(directory, file))), expected, file);
  const reviews = JSON.parse(fs.readFileSync(path.join(directory, 'reviews.json'), 'utf8'));
  assert.deepEqual(report.summary, skillSummary(report.results, reviews));
  for (const task of report.tasks) {
    assert(!/terse|skill|AGENTS|candidateId|--run|\bbegin\b|\bdecide\b/i.test(task.prompt));
    assert.equal(hash(task.prompt), task.promptHash);
    assert.deepEqual(report.results.filter(item => item.taskId === task.id).map(item => item.repetition).sort(), [1, 2]);
  }

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-pqueue-replay-'));
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('terse-pqueue-replay-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const specification = JSON.parse(archive.files['benchmarks/p-queue/project.json']);
  for (const result of report.results) await t.test(result.artifactId, async () => {
    const task = report.tasks.find(item => item.id === result.taskId);
    assert.equal(result.promptHash, task.promptHash);assert.equal(result.evidence.promptHash, task.promptHash);
    const initialScope = hash(JSON.stringify(Object.keys(upstream.files).sort().filter(file => inScope(file, result.editable)).map(file => [file, hash(upstream.files[file])])));
    assert.equal(result.initialScopeHash, initialScope);
    assert.equal(result.verification.length, 4);
    assert.deepEqual(result.verification[0].args, specification.buildArguments);
    assert.deepEqual(result.verification[2].args, specification.upstreamArguments);
    assert(result.verification[1].args.includes('--import=tsx/esm'));assert(result.verification[3].args.includes('--strict'));
    assert.equal(result.correct, Object.values(result.acceptance.checks).every(item => item.passed) && !result.tampered.length);
    if (result.acceptance.checks.acceptance.passed) assert.deepEqual(result.acceptance.checks.acceptance.testCounts,
      {tests: task.id === 'modify' ? 5 : 4, pass: task.id === 'modify' ? 5 : 4, fail: 0, cancelled: 0});
    if (result.acceptance.checks.upstream.passed) assert.deepEqual(result.acceptance.checks.upstream.counts, {passed: 45, knownFailures: 2});
    for (const [file, field] of [[result.patch, 'patchHash'], [result.observations, 'observationsHash'], [result.analysis, 'analysisHash']]) {
      assert.equal(hash(fs.readFileSync(path.join(directory, file))), result.evidence[field]);
    }
    const observations = JSON.parse(fs.readFileSync(path.join(directory, result.observations), 'utf8'));
    assert.deepEqual(result.workflow, skillWorkflow(observations, {initialHash: result.baselineHash, finalHash: result.snapshotHash,
      initialScopeHash: result.initialScopeHash, finalScopeHash: result.finalScopeHash, editable: result.editable, verification: result.verification,
      removals: task.remove, traceComplete: result.events.completed && !result.observationErrors.length}));
    const analysis = JSON.parse(fs.readFileSync(path.join(directory, result.analysis), 'utf8'));
    for (const field of ['newDuplications', 'possibleDuplications', 'cleanup', 'duplicationError']) assert.deepEqual(result[field], analysis[field]);
    assert(!Object.hasOwn(result.events, 'finalMessage'));

    // This is dependency-free static replay, not another AVA/type/runtime run.
    // Live sessions already have separately captured four-command parent checks.
    const project = path.join(parent, result.artifactId);fs.mkdirSync(project);
    for (const [file, input] of Object.entries(upstream.files)) {
      assert(!file.split('/').includes('..'));
      const target = path.join(project, file);fs.mkdirSync(path.dirname(target), {recursive: true});fs.writeFileSync(target, input.replaceAll('\r\n', '\n'));
    }
    for (const [file, input] of Object.entries(archive.files).filter(([file]) => file.startsWith('skills/terse/'))) {
      const target = path.join(project, '.agents', file);fs.mkdirSync(path.dirname(target), {recursive: true});fs.writeFileSync(target, input.replaceAll('\r\n', '\n'));
    }
    fs.writeFileSync(path.join(project, 'package-lock.json'), upstream.dependencyLock);
    fs.writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify(report.upstream.preparation.configuration));
    fs.writeFileSync(path.join(project, 'terse.config.json'), JSON.stringify({exclude: [...specification.exclude, 'acceptance'], minTokens: 50, minLines: 5, duplicatePolicy: 'review', verification: result.verification}));
    execFileSync('git', ['init', '-q'], {cwd: project});execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '.'], {cwd: project, stdio: 'pipe'});
    const before = snapshot(project);
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--', path.join(directory, result.patch)], {cwd: project, stdio: 'pipe'});
    const replay = await analyzeEvaluation(project, before, task.remove);
    if (!result.duplicationError) {
      assert.equal(replay.duplicationError, null);
      assert.equal(replay.newDuplications, result.newDuplications);assert.equal(replay.possibleDuplications, result.possibleDuplications);
      assert.deepEqual(replay.cleanup, result.cleanup);
    }
  });
});
