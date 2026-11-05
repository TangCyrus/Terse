import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { repository } from './lib/workspace.mjs';
import { pairedSummary } from './lib/agent-events.mjs';
import { runAgent } from './lib/agent-runner.mjs';
import { begin, rootOf, snapshot } from '../dist/project.js';
import { clones, newClones, indexSources } from '../dist/analyze.js';
import { showConfiguration, flattenConfiguration, verifyConfiguration, collectChanges, upstreamCounts } from './lib/benchmark-project.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, codex: { type: 'string', default: 'codex' }, repetitions: { type: 'string' }, workflow: { type: 'string' },
  suite: {type: 'string', default: 'p-map'}, 'preflight-only': {type: 'boolean'} } });
assert(['p-map', 'p-queue'].includes(values.suite), '--suite must be p-map or p-queue');
const workflowMode = values.workflow ?? (values.suite === 'p-queue' ? 'commands' : 'manual');
assert(['manual', 'commands'].includes(workflowMode), '--workflow must be manual or commands');
assert(values.source, 'Pass --source <clean checkout with installed development dependencies>');
const source = fs.realpathSync(values.source);
const fixture = path.join(repository, 'benchmarks', values.suite);
const specification = JSON.parse(fs.readFileSync(path.join(fixture, 'project.json'), 'utf8'));
const multiTask = !!specification.tasks;
const repetitions = Number(values.repetitions ?? specification.repetitions);
assert(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 10);
const digest = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
assert.equal(git('-C', source, 'rev-parse', 'HEAD').trim(), specification.commit);
execFileSync('git', ['-C', source, 'diff', 'HEAD', '--exit-code'], { stdio: 'pipe' });
const files = git('-C', source, 'ls-files', '-z').split('\0').filter(Boolean);
assert(fs.existsSync(path.join(source, 'node_modules/ava/entrypoints/cli.mjs')), 'Install upstream development dependencies first');
assert(fs.existsSync(path.join(source, 'package-lock.json')), 'Prepare with npm install --ignore-scripts --package-lock=true');
const dependencyLock = fs.readFileSync(path.join(source, 'package-lock.json'));
fs.mkdirSync(path.join(repository, '.terse'), { recursive: true });
const output = fs.mkdtempSync(path.join(repository, '.terse/agent-benchmark-'));
fs.writeFileSync(path.join(output, 'package-lock.json'), dependencyLock);
const cliVersion = execFileSync(values.codex, ['--version'], { encoding: 'utf8' }).trim();
const taskDefinitions = (specification.tasks ?? [{id: specification.task, taskFile: 'task.md', acceptance: 'acceptance.mjs', typeAcceptance: 'acceptance-types.mts',
  query: 'pMap concurrency mapper skip abort', editable: specification.editable, remove: []}]).map(task => {
  assert(/^[a-z0-9-]+$/.test(task.id));
  const acceptanceFiles = [task.acceptance, ...(multiTask ? ['support.mjs'] : [])];
  const acceptanceHashes = Object.fromEntries(acceptanceFiles.sort().map(file => [file, digest(fs.readFileSync(path.join(fixture, file)))]));
  return {...task, text: fs.readFileSync(path.join(fixture, task.taskFile), 'utf8'),
    taskHash: digest(fs.readFileSync(path.join(fixture, task.taskFile))), acceptanceHashes,
    acceptanceHash: multiTask ? digest(JSON.stringify(acceptanceHashes)) : acceptanceHashes[task.acceptance],
    typeAcceptanceHash: digest(fs.readFileSync(path.join(fixture, task.typeAcceptance)))};
});
const oracleHashes = Object.fromEntries([...new Set(taskDefinitions.flatMap(task => [task.taskFile, task.typeAcceptance, ...Object.keys(task.acceptanceHashes)]))]
  .map(file => [file, digest(fs.readFileSync(path.join(fixture, file)))]));
const terseCli = path.join(repository, 'dist/cli.js');
const results = [];
const env = { ...process.env, FORCE_COLOR: '0' };
delete env.NODE_TEST_CONTEXT;
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const upstreamArguments = specification.upstreamArguments ?? ['node_modules/ava/entrypoints/cli.mjs'];
const originalConfiguration = specification.flattenTsconfig ? showConfiguration(source) : null;
const flattened = originalConfiguration ? flattenConfiguration(originalConfiguration, source) : null;
const preparation = flattened ? { kind: 'equivalent-flat-tsconfig', originalHash: digest(fs.readFileSync(path.join(source, 'tsconfig.json'))), configuration: flattened } : null;

function verify(project, label, args, directory) {
  const start = performance.now();
  const check = spawnSync(process.execPath, args, { cwd: project, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const log = `${check.stdout ?? ''}\n${check.stderr ?? ''}`;
  fs.writeFileSync(path.join(directory, `${label}.log`), log);
  const counts = label.startsWith('upstream') && specification.upstreamCounts ? upstreamCounts(log) : undefined;
  return { exitCode: check.status, error: check.error?.message ?? null,
    passed: check.status === 0 && !check.error && (!counts || JSON.stringify(counts) === JSON.stringify(specification.upstreamCounts)),
    elapsedMs: Math.round(performance.now() - start), logHash: digest(log), ...(counts ? {counts} : {}) };
}

function checksFor(task) {
  return { ...(specification.buildArguments ? {build: specification.buildArguments} : {}),
    acceptance: [...(specification.loaderArguments ?? []), '--test', path.join(fixture, task.acceptance)],
    upstream: upstreamArguments,
    types: ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022', '--esModuleInterop', '../acceptance-types.mts'] };
}

function prepareProject(directory, task) {
  const project = path.join(directory, 'project');
  fs.mkdirSync(project, {recursive: true});
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(project, file)), {recursive: true});
    fs.copyFileSync(path.join(source, file), path.join(project, file));
  }
  fs.writeFileSync(path.join(project, 'package-lock.json'), dependencyLock);
  fs.cpSync(path.join(source, 'node_modules'), path.join(project, 'node_modules'), {recursive: true});
  if (flattened) {
    write(path.join(project, 'tsconfig.json'), flattened);
    verifyConfiguration(originalConfiguration, showConfiguration(project), source, project);
  }
  fs.appendFileSync(path.join(project, '.gitignore'), '\n.terse/\n');
  execFileSync('git', ['init', '-q'], {cwd: project});
  execFileSync('git', ['add', '.'], {cwd: project, stdio: 'pipe'});
  const root = rootOf(project);
  fs.copyFileSync(path.join(fixture, task.typeAcceptance), path.join(directory, 'acceptance-types.mts'));
  const commands = checksFor(task);
  write(path.join(root, 'terse.config.json'), {exclude: specification.exclude ?? ['test.js', 'index.test-d.ts'], minTokens: 50, minLines: 5, duplicatePolicy: 'review',
    verification: Object.values(commands).map(args => ({command: 'node', args, timeoutMs: 120_000}))});
  // This is prepared baseline input, not an untracked file created by the agent.
  execFileSync('git', ['add', 'terse.config.json'], {cwd: root, stdio: 'pipe'});
  const state = snapshot(root);
  assert.deepEqual(indexSources(state, root).errors, [], 'Prepared project must be analyzable by Terse before starting agents');
  assert.deepEqual(collectChanges(root, task.editable), {changed: [], outsideScope: [], patch: ''}, 'Prepared inputs must be clean before starting agents');
  return {root, commands, before: state};
}

// Verify the upstream start and the same prepared project before any model is called.
const preflight = {upstream: verify(source, 'upstream-before', upstreamArguments, output), tasks: []};
assert(preflight.upstream.passed, 'Upstream baseline tests must pass');
const dry = path.join(output, 'preflight');
const dryProject = prepareProject(dry, taskDefinitions[0]);
if (dryProject.commands.build) {
  preflight.build = verify(dryProject.root, 'build-before', dryProject.commands.build, dry);
  assert(preflight.build.passed, 'Equivalent configuration must compile before changes');
}
for (const task of taskDefinitions) {
  const before = verify(dryProject.root, `acceptance-before-${task.id}`, checksFor(task).acceptance, dry);
  assert(!before.passed, `${task.id}: acceptance must fail before implementing the task`);
  preflight.tasks.push({id: task.id, before});
}
const taskReceipts = taskDefinitions.map(({text, ...task}) => task);
write(path.join(output, 'plan.json'), { ...specification, repetitions, workflow: workflowMode, cliVersion,
  execution: 'workspace-write with automatic approval; preserve local Windows/proxy configuration', tasks: taskReceipts,
  dependencyLockHash: digest(dependencyLock), preparation, preflight });
if (values['preflight-only']) { console.log(JSON.stringify({artifactDirectory: output, preparation, preflight}, null, 2)); process.exit(0); }

for (const [taskIndex, task] of taskDefinitions.entries()) {
for (let repetition = 1; repetition <= repetitions; repetition++) {
  const arms = (repetition + taskIndex) % 2 ? ['control', 'terse'] : ['terse', 'control'];
  for (const arm of arms) {
    const artifactId = `${multiTask ? `${task.id}-` : ''}pair-${repetition}-${arm}`;
    const directory = path.join(output, artifactId);
    const setupStarted = performance.now();
    const {root, commands, before} = prepareProject(directory, task);
    const protectedFiles = [...files.filter(file => !task.editable.includes(file)), 'terse.config.json', 'package-lock.json'];
    const protectedHashes = Object.fromEntries(protectedFiles.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
    const run = begin(root, task.text);
    const preparationMs = Math.round(performance.now() - setupStarted);
    const verificationInstructions = Object.entries(commands).map(([name, args]) => `${name}: node ${args.map(argument => JSON.stringify(argument)).join(' ')}`).join('\n');
    const common = `${task.text}\n\nWorking directory: ${root}\n${verificationInstructions}\nYou may read supplied acceptance files, and Terse when provided, but no other experiment artifacts.\nTime limit: ${specification.timeoutMs / 1000} seconds.\n${multiTask ? 'Windows execution note: tsx may fail before tests with uv_os_get_passwd ENOMEM under a restricted token. Use normal automatic approval for the supplied checks (including Terse check when applicable); do not edit code or configuration to bypass initialization failures. Upstream baseline is 45 passing tests plus 2 pre-existing expected failures.\n' : ''}`;
    const removalInstructions = task.remove.length ? `Include these exact declared removals in the decision: ${JSON.stringify(task.remove)}. For a file removal, --remove is available. For symbol removal use decide --input with the published schema, writing the input only inside .terse. Uncertain member-reference review is not itself a behavioral failure; report it honestly instead of dropping the removal declaration.` : '';
    const recordInstructions = workflowMode === 'commands'
      ? `Read the candidates, their candidateId and decisionGuide. For a simple decision use node ${JSON.stringify(terseCli)} with decisionGuide.argvTemplate. For a complex record prepare the complete decision file using the published schema, then use decisionGuide.inputArgvTemplate. In input mode optional --candidate IDs only assert candidates already listed in input.considered. Keep decision fields in the input file and omit decisionGuide.inputExclusiveFlags from the command line. Do not hand-edit decision.json or guess record fields; decide validates and writes the record. Then implement.`
      : `Read the candidates, complete ${JSON.stringify(run.decisionPath)} with your actual strategy and considered candidates, then implement.`;
    const treatment = arm === 'terse' ? `\nUse Terse before editing: node ${JSON.stringify(terseCli)} context --cwd ${JSON.stringify(root)} --run ${run.run} --query ${JSON.stringify(task.query)} --limit 10 --json. ${recordInstructions} ${removalInstructions} Before finishing run node ${JSON.stringify(terseCli)} check --cwd ${JSON.stringify(root)} --run ${run.run}${workflowMode === 'commands' ? ' --summary' : ''} --json, inspect findings, and resolve duplication where appropriate within the same time limit. Explain unresolved findings honestly.\n`
      : '\nWork normally using project source and the supplied tests. Do not invoke Terse or read .terse records.\n';
    console.error(`Starting ${artifactId}`);
    const agent = await runAgent({project: root, prompt: common + treatment, directory, codex: values.codex, specification, terseCli, env});
    const tampered = protectedFiles.filter(file => !fs.existsSync(path.join(root, file)) || digest(fs.readFileSync(path.join(root, file))) !== protectedHashes[file]);
    tampered.push(...Object.entries(oracleHashes).filter(([file, hash]) => !fs.existsSync(path.join(fixture, file)) || digest(fs.readFileSync(path.join(fixture, file))) !== hash)
      .map(([file]) => `benchmark/${file}`));
    if (!fs.existsSync(path.join(directory, 'acceptance-types.mts')) || digest(fs.readFileSync(path.join(directory, 'acceptance-types.mts'))) !== task.typeAcceptanceHash) tampered.push('acceptance-types.mts');
    const checkStart = performance.now();
    const checks = Object.fromEntries(Object.entries(commands).map(([name, args]) => [name, verify(root, name, args, directory)]));
    let newDuplications = null, duplicationError = null;
    try {
      const after = snapshot(root);
      const index = indexSources(after, root, before.files);
      if (index.errors.length) throw new Error(index.errors.join('; '));
      const findings = newClones(before, after, await clones(after));
      newDuplications = findings.length;
      write(path.join(directory, 'duplications.json'), findings);
    } catch (error) { duplicationError = error.message; }
    const {changed, outsideScope, patch} = collectChanges(root, task.editable);
    fs.writeFileSync(path.join(directory, 'implementation.patch'), patch);
    let workflow = arm === 'control' ? null : false;
    let terseStatus = null, terseRules = [];
    if (arm === 'terse') {
      try {
        const runPath = path.dirname(run.decisionPath);
        const history = JSON.parse(fs.readFileSync(path.join(runPath, 'context.json'), 'utf8'));
        const report = JSON.parse(fs.readFileSync(path.join(runPath, 'report.json'), 'utf8'));
        const decision = JSON.parse(fs.readFileSync(run.decisionPath, 'utf8'));
        terseStatus = report.status; terseRules = report.findings.map(finding => finding.rule);
        workflow = history.some(entry => entry.atBaseline && entry.snapshotHash === before.hash && entry.errors.length === 0)
          && decision.rationale?.trim().length > 0 && decision.considered?.length > 0
          && report.snapshotHash === snapshot(root).hash
          && task.remove.every(removal => decision.remove.some(actual => actual.path === removal.path && actual.symbol === removal.symbol));
      } catch { /* Missing or stale workflow evidence remains false. */ }
    }
    const controlUsedTerse = arm === 'control' && (agent.events.decisions.attempts > 0
      || ['context.json', 'report.json'].some(file => fs.existsSync(path.join(path.dirname(run.decisionPath), file))));
    const result = { ...(multiTask ? {taskId: task.id} : {}), artifactId, repetition, arm, baselineHash: before.hash, acceptanceHash: task.acceptanceHash,
      preparationMs, terseStatus, terseRules,
      agentMs: agent.agentMs, evaluationMs: Math.round(performance.now() - checkStart), agentExitCode: agent.exitCode,
      timedOut: agent.timedOut, blockedByPolicy: agent.blockedByPolicy, controlUsedTerse, events: agent.events, checks, workflow, tampered, outsideScope,
      protocolValid: agent.exitCode === 0 && !agent.timedOut && !agent.blockedByPolicy && agent.events.completed && agent.events.commandCount > 0 && !controlUsedTerse && tampered.length === 0 && outsideScope.length === 0 && !duplicationError && (arm === 'control' || workflow),
      correct: Object.values(checks).every(check => check.passed) && tampered.length === 0,
      newDuplications, duplicationError, changed,
      evidence: { patchHash: digest(patch), eventHash: digest(fs.readFileSync(path.join(directory, 'agent.jsonl'))) } };
    results.push(result);
    write(path.join(directory, 'result.json'), result);
    write(path.join(output, 'progress.json'), results);
    console.error(`Finished ${artifactId}: correct=${result.correct}, duplicates=${newDuplications}, protocol=${result.protocolValid}`);
  }
}
}
const summary = { schemaVersion: multiTask ? 2 : 1, kind: 'open-source-agent-comparison', project: specification,
  repetitions, workflow: workflowMode, cliVersion, runtime: { node: process.version, platform: process.platform, arch: process.arch },
  terseRevision: git('-C', repository, 'rev-parse', 'HEAD').trim(),
  ...(multiTask ? {tasks: taskReceipts, preparation} : {taskHash: taskDefinitions[0].taskHash, acceptanceHash: taskDefinitions[0].acceptanceHash, typeAcceptanceHash: taskDefinitions[0].typeAcceptanceHash}),
  dependencyLockHash: digest(dependencyLock), preflight,
  results, pairs: pairedSummary(results), artifactDirectory: output };
write(path.join(output, 'comparison.json'), summary);
console.log(JSON.stringify(summary, null, 2));
