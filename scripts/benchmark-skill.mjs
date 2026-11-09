import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {skillCases} from './skill-cases.mjs';
import {cases as authoredCases} from './evaluation-cases.mjs';
import {repository, invoke} from './lib/workspace.mjs';
import {prepareEvaluation, analyzeEvaluation} from './lib/evaluation-project.mjs';
import {collectChanges, protectedFileEvidence, inScope} from './lib/benchmark-project.mjs';
import {runAgent} from './lib/agent-runner.mjs';
import {hash, hashFiles, list, write, scopeHash, skillObserver, skillWorkflow, captureRunStates, removalWorkflow} from './lib/skill-evidence.mjs';
import {snapshot} from '../dist/project.js';

const {values} = parseArgs({options: {codex: {type: 'string', default: 'codex'}, repetitions: {type: 'string', default: '2'}, suite: {type: 'string', default: 'orders'}, source: {type: 'string'}, 'preflight-only': {type: 'boolean'}}});
assert(['orders', 'p-queue'].includes(values.suite), '--suite must be orders or p-queue');
assert(values.suite === 'p-queue' || !values.source, '--source is only valid for p-queue');
const pqueue = values.suite === 'p-queue' ? await import('./lib/pqueue-skill.mjs') : null;
const external = pqueue?.createPqueueSkillSuite(values.source) ?? null;
const cases = external?.cases ?? skillCases;
const repetitions = Number(values.repetitions);
assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
const env = {...process.env, FORCE_COLOR: '0'};delete env.NODE_TEST_CONTEXT;
const specification = {model: 'gpt-6.1-sol', reasoningEffort: 'medium', timeoutMs: 600_000};
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim();
const cliVersion = execFileSync(values.codex, ['--version'], {env, encoding: 'utf8'}).trim();
fs.mkdirSync(path.join(repository, '.terse'), {recursive: true});
const output = fs.mkdtempSync(path.join(repository, '.terse/skill-agent-'));
const terseCli = path.join(repository, 'dist/cli.js');
const upstream = external?.saveInputs(output);
const fixtureFiles = [...new Set([
  ...['examples/orders', 'examples/evaluation', 'skills/terse', 'src'].flatMap(directory => list(path.join(repository, directory)).map(file => `${directory}/${file}`)),
  ...list(path.join(repository, 'dist')).filter(file => file.endsWith('.js')).map(file => `dist/${file}`),
  'package.json', 'package-lock.json', 'scripts/skill-cases.mjs', 'scripts/evaluation-cases.mjs', 'scripts/benchmark-skill.mjs',
  'scripts/export-skill-benchmark.mjs', 'scripts/lib/skill-evidence.mjs', 'scripts/lib/agent-runner.mjs', 'scripts/lib/agent-events.mjs',
  'scripts/lib/workspace.mjs', 'scripts/lib/benchmark-project.mjs', 'scripts/lib/evaluation-project.mjs', 'test/skill-agent.test.mjs',
  'scripts/lib/open-source-project.mjs', 'scripts/lib/pqueue-skill.mjs',
  ...(external ? [...pqueue.pqueueFixtureFiles, 'test/pqueue-skill.test.mjs', 'test/removal-workflow.test.mjs'] : []),
])].sort();
const fixtureHashes = hashFiles(repository, fixtureFiles);
const tasks = cases.map(({id, prompt, remove, acceptance, editable}) => ({id, prompt, promptHash: hash(prompt), remove, editable: editable ?? ['src/'],
  acceptanceHash: hash(fs.readFileSync(path.join(repository, external ? `benchmarks/p-queue/${acceptance}` : acceptance)))}));

function prepare(scenario, label) {
  const prepared = external ? external.prepare(path.join(output, label), scenario) : prepareEvaluation(output, `${label}/project`, scenario);
  const initialized = invoke(prepared.project, ['init']);
  assert.equal(initialized.verificationConfigured, true);
  assert(!fs.existsSync(path.join(prepared.project, '.terse/runs')), 'The host must not begin a task or inject candidates');
  execFileSync('git', ['add', '.'], {cwd: prepared.project, stdio: 'pipe'});
  assert.equal(collectChanges(prepared.project, scenario.editable ?? ['src/']).patch, '');
  return {...prepared, before: snapshot(prepared.project), initialized};
}
function verify(project, config, directory, filename) {
  if (external) return external.verify(project, config, directory, filename.replace(/\.log$/, ''));
  const result = spawnSync(process.execPath, config.verification[0].args, {cwd: project, env, encoding: 'utf8', timeout: 30_000});
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  fs.writeFileSync(path.join(directory, filename), log, {flag: 'wx'});
  return {passed: !result.error && result.status === 0 && /tests 3\b/.test(log), exitCode: result.status,
    error: result.error?.message ?? null, logHash: hash(log)};
}
const preflight = cases.map(scenario => {
  const {project, config, sources} = prepare(scenario, `preflight-${scenario.id}`);
  if (external) {
    const initial = verify(project, config, path.dirname(project), 'initial');
    assert(initial.checks.build.passed && initial.checks.upstream.passed, 'Prepared upstream behavior must be healthy');
    assert.equal(initial.checks.acceptance.passed, false, 'Task requirement must start unmet');
    const reference = external.reference(project, scenario);
    const completed = verify(project, config, path.dirname(project), 'reference');
    assert(completed.passed, 'Historical reference must pass all unchanged verification');
    return {taskId: scenario.id, supportedBaseline: true, initial, referencePass: true, reference};
  }
  const supported = spawnSync(process.execPath, ['--test', 'test/orders.test.mjs', 'test/routes.test.mjs'], {cwd: project, env, encoding: 'utf8'});
  assert.equal(supported.status, 0);
  const initial = verify(project, config, path.dirname(project), 'initial-acceptance.log');
  assert.equal(initial.passed, scenario.id === 'delete');
  // Existing authored solutions prove attainable acceptance, never agent drafts.
  const authored = authoredCases.find(item => item.id === scenario.id);
  authored.variants.find(item => ['reuse', 'cleanup'].includes(item.id)).edit(sources);
  assert.equal(verify(project, config, path.dirname(project), 'reference-acceptance.log').passed, true);
  return {taskId: scenario.id, supportedBaseline: true, initial, referencePass: true};
});
const plan = {schemaVersion: 1, kind: 'agent-skill-integration', terseRevision: revision, specification, repetitions, cliVersion,
  suite: values.suite, ...(upstream ? {upstream, removalTracking: 'removal-declarations/1'} : {}),
  tasks, fixtureHashes, preflight, criteria: 'Cold fresh sessions receive only ordinary development requirements. The host installs the released skill but does not begin, retrieve, decide, edit source, remind or repair. Workflow ordering and full final verification need observed evidence; behavior and source review are separate.'};
write(path.join(output, 'plan.json'), plan);
if (values['preflight-only']) {console.log(JSON.stringify({output, preflight}, null, 2));process.exit(0);}

const results = [];
for (let repetition = 1; repetition <= repetitions; repetition++) for (const scenario of cases) {
  const artifactId = `${scenario.id}-session-${repetition}`;
  const {project, config, before, initialized} = prepare(scenario, artifactId);
  const directory = path.dirname(project);
  write(path.join(directory, 'initialization.json'), initialized);
  const editable = scenario.editable ?? ['src/'];
  const initialScopeHash = scopeHash(project, editable);
  const protectedFiles = [...list(project).filter(file => !inScope(file, editable)), '.terse/agent.json'];
  const protectedHashes = hashFiles(project, protectedFiles);
  const observer = skillObserver(project, protectedHashes, {editable});
  console.error(`Starting ${artifactId}`);
  const agent = await runAgent({project, prompt: scenario.prompt, directory, codex: values.codex, specification, terseCli, env, onEvent: observer.observe});
  write(path.join(directory, 'observations.json'), observer.observations);
  const analysis = await analyzeEvaluation(project, before, scenario.remove);
  const acceptance = verify(project, config, directory, 'acceptance.log');
  const integrity = protectedFileEvidence(project, protectedHashes, external ? protectedFiles.filter(file => file.startsWith('acceptance/')) : config.verification[0].args.slice(1));
  const changes = collectChanges(project, editable);
  fs.writeFileSync(path.join(directory, 'implementation.patch'), changes.patch, {flag: 'wx'});
  const {after, ...structural} = analysis;
  const finalScopeHash = scopeHash(project, editable);
  write(path.join(directory, 'analysis.json'), structural);
  const workflowOptions = {initialHash: before.hash, finalHash: after?.hash ?? null,
    editable, initialScopeHash, finalScopeHash,
    verification: config.verification, removals: scenario.remove,
    traceComplete: agent.events.completed && !agent.observationErrors.length};
  const workflow = skillWorkflow(observer.observations, workflowOptions);
  const finalRunStates = external ? captureRunStates(project) : undefined;
  const editViolations = observer.observations.flatMap(item => item.sourceEdits).filter(item => !inScope(item.path, editable) && !item.path.startsWith('.terse/'));
  const result = {artifactId, taskId: scenario.id, repetition, baselineHash: before.hash, snapshotHash: after?.hash ?? null,
    editable, initialScopeHash, finalScopeHash,
    acceptanceHash: integrity.acceptanceHash, promptHash: hash(scenario.prompt), correct: acceptance.passed && !integrity.tampered.length,
    acceptance, verification: config.verification, workflow, protocolValid: agent.exitCode === 0 && !agent.timedOut && !agent.blockedByPolicy && agent.events.completed
      && !agent.observationErrors.length && !integrity.tampered.length && !changes.outsideScope.length && !editViolations.length
      && !analysis.duplicationError && observer.observations.every(item => !item.tampered.length),
    tampered: integrity.tampered, editViolations, outsideScope: changes.outsideScope, changed: changes.changed,
    newDuplications: analysis.newDuplications, possibleDuplications: analysis.possibleDuplications, cleanup: analysis.cleanup, duplicationError: analysis.duplicationError,
    events: agent.events, agentExitCode: agent.exitCode, timedOut: agent.timedOut, blockedByPolicy: agent.blockedByPolicy,
    observationErrors: agent.observationErrors, agentMs: agent.agentMs,
    ...(external ? {finalRunStates, removalWorkflow: removalWorkflow(observer.observations, {...workflowOptions, finalRunStates})} : {}),
    evidence: {patchHash: hash(changes.patch), eventHash: hash(fs.readFileSync(path.join(directory, 'agent.jsonl'))),
      promptHash: hash(fs.readFileSync(path.join(directory, 'prompt.txt'))), observationsHash: hash(fs.readFileSync(path.join(directory, 'observations.json'))),
      analysisHash: hash(fs.readFileSync(path.join(directory, 'analysis.json'))), initializationHash: hash(fs.readFileSync(path.join(directory, 'initialization.json')))}};
  results.push(result);write(path.join(directory, 'result.json'), result);
  // Each finished run is durable even if a later process is interrupted.
  write(path.join(output, `progress-${results.length}.json`), results);
  console.error(`Finished ${artifactId}: correct=${result.correct}, workflow=${workflow.completed}, protocol=${result.protocolValid}`);
}
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim(), revision);
write(path.join(output, 'report.json'), {...plan, runtime: {node: process.version, platform: process.platform, arch: process.arch}, results});
console.log(JSON.stringify({output, runs: results.length, correct: results.filter(item => item.correct).length, workflowCompleted: results.filter(item => item.workflow.completed).length}, null, 2));
