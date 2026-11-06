import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {skillCases} from './skill-cases.mjs';
import {cases as authoredCases} from './evaluation-cases.mjs';
import {repository, invoke} from './lib/workspace.mjs';
import {prepareEvaluation, analyzeEvaluation} from './lib/evaluation-project.mjs';
import {collectChanges, protectedFileEvidence} from './lib/benchmark-project.mjs';
import {runAgent} from './lib/agent-runner.mjs';
import {hash, hashFiles, list, write, skillObserver, skillWorkflow} from './lib/skill-evidence.mjs';
import {snapshot} from '../dist/project.js';

const {values} = parseArgs({options: {codex: {type: 'string', default: 'codex'}, repetitions: {type: 'string', default: '2'}, 'preflight-only': {type: 'boolean'}}});
const repetitions = Number(values.repetitions);
assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
const env = {...process.env, FORCE_COLOR: '0'};delete env.NODE_TEST_CONTEXT;
const specification = {model: 'gpt-6.1-sol', reasoningEffort: 'medium', timeoutMs: 600_000};
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim();
const cliVersion = execFileSync(values.codex, ['--version'], {env, encoding: 'utf8'}).trim();
fs.mkdirSync(path.join(repository, '.terse'), {recursive: true});
const output = fs.mkdtempSync(path.join(repository, '.terse/skill-agent-'));
const terseCli = path.join(repository, 'dist/cli.js');
const fixtureFiles = [...new Set([
  ...['examples/orders', 'examples/evaluation', 'skills/terse', 'src'].flatMap(directory => list(path.join(repository, directory)).map(file => `${directory}/${file}`)),
  ...list(path.join(repository, 'dist')).filter(file => file.endsWith('.js')).map(file => `dist/${file}`),
  'package.json', 'package-lock.json', 'scripts/skill-cases.mjs', 'scripts/evaluation-cases.mjs', 'scripts/benchmark-skill.mjs',
  'scripts/export-skill-benchmark.mjs', 'scripts/lib/skill-evidence.mjs', 'scripts/lib/agent-runner.mjs', 'scripts/lib/agent-events.mjs',
  'scripts/lib/workspace.mjs', 'scripts/lib/benchmark-project.mjs', 'scripts/lib/evaluation-project.mjs', 'test/skill-agent.test.mjs',
])].sort();
const fixtureHashes = hashFiles(repository, fixtureFiles);
const tasks = skillCases.map(({id, prompt, remove, acceptance}) => ({id, prompt, promptHash: hash(prompt), remove, acceptanceHash: hash(fs.readFileSync(path.join(repository, acceptance)))}));

function prepare(scenario, label) {
  const prepared = prepareEvaluation(output, `${label}/project`, scenario);
  const initialized = invoke(prepared.project, ['init']);
  assert.equal(initialized.verificationConfigured, true);
  assert(!fs.existsSync(path.join(prepared.project, '.terse/runs')), 'The host must not begin a task or inject candidates');
  execFileSync('git', ['add', '.'], {cwd: prepared.project, stdio: 'pipe'});
  assert.equal(collectChanges(prepared.project, ['src/']).patch, '');
  return {...prepared, before: snapshot(prepared.project), initialized};
}
function verify(project, config, directory, filename) {
  const result = spawnSync(process.execPath, config.verification[0].args, {cwd: project, env, encoding: 'utf8', timeout: 30_000});
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  fs.writeFileSync(path.join(directory, filename), log, {flag: 'wx'});
  return {passed: !result.error && result.status === 0 && /tests 3\b/.test(log), exitCode: result.status,
    error: result.error?.message ?? null, logHash: hash(log)};
}
const preflight = skillCases.map(scenario => {
  const {project, config, sources} = prepare(scenario, `preflight-${scenario.id}`);
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
  tasks, fixtureHashes, preflight, criteria: 'Cold fresh sessions receive only ordinary development requirements. The host installs the released skill but does not begin, retrieve, decide, edit source, remind or repair. Workflow ordering and full final verification need observed evidence; behavior and source review are separate.'};
write(path.join(output, 'plan.json'), plan);
if (values['preflight-only']) {console.log(JSON.stringify({output, preflight}, null, 2));process.exit(0);}

const results = [];
for (let repetition = 1; repetition <= repetitions; repetition++) for (const scenario of skillCases) {
  const artifactId = `${scenario.id}-session-${repetition}`;
  const {project, config, before, initialized} = prepare(scenario, artifactId);
  const directory = path.dirname(project);
  write(path.join(directory, 'initialization.json'), initialized);
  const protectedHashes = hashFiles(project, [...list(project).filter(file => !file.startsWith('src/')), '.terse/agent.json']);
  const observer = skillObserver(project, protectedHashes);
  console.error(`Starting ${artifactId}`);
  const agent = await runAgent({project, prompt: scenario.prompt, directory, codex: values.codex, specification, terseCli, env, onEvent: observer.observe});
  write(path.join(directory, 'observations.json'), observer.observations);
  const analysis = await analyzeEvaluation(project, before, scenario.remove);
  const acceptance = verify(project, config, directory, 'acceptance.log');
  const integrity = protectedFileEvidence(project, protectedHashes, config.verification[0].args.slice(1));
  const changes = collectChanges(project, ['src/']);
  fs.writeFileSync(path.join(directory, 'implementation.patch'), changes.patch, {flag: 'wx'});
  const {after, ...structural} = analysis;
  write(path.join(directory, 'analysis.json'), structural);
  const workflow = skillWorkflow(observer.observations, {initialHash: before.hash, finalHash: after?.hash ?? null,
    verification: config.verification, removals: scenario.remove,
    traceComplete: agent.events.completed && !agent.observationErrors.length});
  const editViolations = observer.observations.flatMap(item => item.sourceEdits).filter(item => !item.path.startsWith('src/') && !item.path.startsWith('.terse/'));
  const result = {artifactId, taskId: scenario.id, repetition, baselineHash: before.hash, snapshotHash: after?.hash ?? null,
    acceptanceHash: integrity.acceptanceHash, promptHash: hash(scenario.prompt), correct: acceptance.passed && !integrity.tampered.length,
    acceptance, verification: config.verification, workflow, protocolValid: agent.exitCode === 0 && !agent.timedOut && !agent.blockedByPolicy && agent.events.completed
      && !agent.observationErrors.length && !integrity.tampered.length && !changes.outsideScope.length && !editViolations.length
      && !analysis.duplicationError && observer.observations.every(item => !item.tampered.length),
    tampered: integrity.tampered, editViolations, outsideScope: changes.outsideScope, changed: changes.changed,
    newDuplications: analysis.newDuplications, possibleDuplications: analysis.possibleDuplications, cleanup: analysis.cleanup, duplicationError: analysis.duplicationError,
    events: agent.events, agentExitCode: agent.exitCode, timedOut: agent.timedOut, blockedByPolicy: agent.blockedByPolicy,
    observationErrors: agent.observationErrors, agentMs: agent.agentMs,
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
