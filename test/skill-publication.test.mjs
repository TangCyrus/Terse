import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {hash, skillWorkflow, skillSummary} from '../scripts/lib/skill-evidence.mjs';
import {prepareEvaluation} from '../scripts/lib/evaluation-project.mjs';

test('published Skill sessions bind frozen inputs, all observations and patch review without selecting successes', async t => {
  const directory = fileURLToPath(new URL('../benchmarks/skill/observed/', import.meta.url));
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
  const archive = JSON.parse(gunzipSync(fs.readFileSync(path.join(directory, '../fixtures', `${report.terseRevision}.json.gz`))).toString('utf8'));
  assert.equal(report.kind, 'agent-skill-integration');assert.equal(report.repetitions, 2);
  assert.equal(report.results.length, 6);assert.equal(archive.schemaVersion, 1);assert.equal(archive.revision, report.terseRevision);
  assert.deepEqual(Object.keys(archive.files).sort(), Object.keys(report.fixtureHashes).sort());
  for (const [file, input] of Object.entries(archive.files)) {
    assert.equal(hash(input), report.fixtureHashes[file], file);
    assert.equal(hash(input.replaceAll('\r\n', '\n')), report.fixtureCanonicalHashes[file], file);
  }
  assert.deepEqual(Object.keys(archive.publicationHashes).sort(), fs.readdirSync(directory).sort());
  for (const [file, expected] of Object.entries(archive.publicationHashes)) assert.equal(hash(fs.readFileSync(path.join(directory, file))), expected, file);
  const reviews = JSON.parse(fs.readFileSync(path.join(directory, 'reviews.json'), 'utf8'));
  assert.deepEqual(report.summary, skillSummary(report.results, reviews));
  assert(!Object.hasOwn(report, 'artifactDirectory'));
  for (const task of report.tasks) {
    assert(!/terse|skill|\.agents|candidateId|--run|\bbegin\b|\bcontext\b|\bdecide\b/i.test(task.prompt));
    assert.equal(hash(task.prompt), task.promptHash);
    assert.deepEqual(report.results.filter(item => item.taskId === task.id).map(item => item.repetition).sort(), [1, 2]);
  }

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-skill-replay-'));
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('terse-skill-replay-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const frozenRoot = path.join(parent, 'frozen');
  // Canonical text avoids platform checkout conversion while retaining the exact
  // original acceptance logic. Byte identities are independently checked above.
  for (const [file, input] of Object.entries(archive.files)) {
    if (!file.startsWith('examples/') && !['scripts/skill-cases.mjs', 'scripts/evaluation-cases.mjs'].includes(file)) continue;
    assert(!file.split('/').some(part => part === '..'));
    const target = path.join(frozenRoot, file);fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, input.replaceAll('\r\n', '\n'));
  }
  const {skillCases} = await import(pathToFileURL(path.join(frozenRoot, 'scripts/skill-cases.mjs')).href);
  const env = {...process.env};delete env.NODE_TEST_CONTEXT;
  for (const result of report.results) await t.test(result.artifactId, () => {
    const task = report.tasks.find(item => item.id === result.taskId);
    assert.equal(result.promptHash, task.promptHash);assert.equal(result.evidence.promptHash, task.promptHash);
    const patch = path.join(directory, result.patch), observationsFile = path.join(directory, result.observations), analysisFile = path.join(directory, result.analysis);
    assert.equal(hash(fs.readFileSync(patch)), result.evidence.patchHash);
    assert.equal(hash(fs.readFileSync(observationsFile)), result.evidence.observationsHash);
    assert.equal(hash(fs.readFileSync(analysisFile)), result.evidence.analysisHash);
    const observations = JSON.parse(fs.readFileSync(observationsFile, 'utf8'));
    assert.deepEqual(observations.map(item => item.sequence), observations.map((_, index) => index));
    assert.deepEqual(result.workflow, skillWorkflow(observations, {initialHash: result.baselineHash, finalHash: result.snapshotHash,
      verification: result.verification, removals: task.remove, traceComplete: result.events.completed && !result.observationErrors.length}));
    // Original v1 observations predate per-command checkAttempts. Their saved
    // raw-event measurement confirms no unobservable check was discarded.
    if (result.workflow.completed && observations.every(item => !Object.hasOwn(item, 'checkAttempts'))) assert.equal(result.events.checks.unknownCalls, 0);
    const analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    for (const key of ['newDuplications', 'possibleDuplications', 'cleanup', 'duplicationError']) assert.deepEqual(result[key], analysis[key]);
    assert(!Object.hasOwn(result.events, 'finalMessage'));
    for (const key of ['eventHash', 'promptHash', 'initializationHash']) assert.match(result.evidence[key], /^[a-f0-9]{64}$/);
    if (result.protocolValid) {
      assert.deepEqual(result.tampered, []);assert.deepEqual(result.outsideScope, []);assert.deepEqual(result.observationErrors, []);
      assert.equal(result.agentExitCode, 0);assert.equal(result.timedOut, false);assert.equal(result.events.completed, true);
      assert(observations.every(item => item.tampered.length === 0));assert.equal(result.duplicationError, null);
    }
    const scenario = skillCases.find(item => item.id === result.taskId);
    const {project} = prepareEvaluation(parent, result.artifactId, scenario, frozenRoot);
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '.'], {cwd: project, stdio: 'pipe'});
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--', patch], {cwd: project, stdio: 'pipe'});
    const replay = spawnSync(process.execPath, result.verification[0].args, {cwd: project, env, encoding: 'utf8', timeout: 30_000});
    assert.equal(replay.error, undefined);assert.equal(replay.signal, null);assert.match(replay.stdout, /tests 3\b/);
    // Historical failures, if any, stay failures in the observed score even if
    // another machine can now execute their patch successfully.
    if (result.acceptance.passed) assert.equal(replay.status, 0, replay.stdout + replay.stderr);
  });
});
