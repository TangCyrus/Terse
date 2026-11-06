import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {skillCases} from '../scripts/skill-cases.mjs';
import {cases} from '../scripts/evaluation-cases.mjs';
import {hash, hashFiles, list, write, skillObserver, skillWorkflow, skillSummary} from '../scripts/lib/skill-evidence.mjs';
import {runAgent} from '../scripts/lib/agent-runner.mjs';
import {exportSkillBenchmark} from '../scripts/export-skill-benchmark.mjs';
import {prepareEvaluation} from '../scripts/lib/evaluation-project.mjs';
import {invoke, repository} from '../scripts/lib/workspace.mjs';
import {snapshot} from '../dist/project.js';

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-skill-eval-'));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('terse-skill-eval-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });return directory;
}
const command = (id, output, text = 'node .agents/skills/terse/scripts/run.mjs') => ({type: 'item.completed', item: {
  id, type: 'command_execution', command: text, aggregated_output: typeof output === 'string' ? output : JSON.stringify(output), exit_code: 0}});

function observedWorkflow(t) {
  const parent = workspace(t), scenario = skillCases[0];
  const {project, config, sources} = prepareEvaluation(parent, 'project', scenario);
  invoke(project, ['init']);execFileSync('git', ['add', '.'], {cwd: project, stdio: 'pipe'});
  const initialHash = snapshot(project).hash;
  const observer = skillObserver(project, hashFiles(project, [...list(project).filter(file => !file.startsWith('src/')), '.terse/agent.json']));
  observer.observe(command('read', fs.readFileSync(path.join(project, '.agents/skills/terse/SKILL.md'), 'utf8'), 'Get-Content .agents/skills/terse/SKILL.md'));
  const begun = invoke(project, ['begin', '--task', scenario.prompt, '--query', 'exportOrders']);observer.observe(command('begin', begun));
  const candidate = begun.context.candidates.find(item => item.path === 'src/orders.ts' && item.symbol === 'exportOrders');
  const decision = invoke(project, ['decide', '--run', begun.run, '--strategy', 'modify', '--candidate', candidate.candidateId, '--rationale', 'Extend the existing export selection.']);
  observer.observe(command('decide', decision));
  cases.find(item => item.id === scenario.id).variants.find(item => item.id === 'reuse').edit(sources);
  observer.observe({type: 'item.completed', item: {id: 'edit', type: 'file_change', changes: [{path: 'src/orders.ts', kind: 'update'}, {path: 'src/routes.ts', kind: 'update'}]}});
  const checked = invoke(project, begun.verificationGuide.argvTemplate);observer.observe(command('check', checked));
  const options = {initialHash, finalHash: snapshot(project).hash, verification: config.verification, traceComplete: true};
  return {observer, options, project, begun, decision, checked};
}

test('skill integration tasks expose only ordinary requirements and have attainable behavior', async t => {
  const parent = workspace(t);
  const frozenRoot = path.join(parent, 'frozen');
  fs.cpSync(path.join(repository, 'examples/orders'), path.join(frozenRoot, 'examples/orders'), {recursive: true});
  fs.cpSync(path.join(repository, 'examples/evaluation'), path.join(frozenRoot, 'examples/evaluation'), {recursive: true});
  for (const scenario of skillCases) await t.test(scenario.id, () => {
    assert(!/terse|skill|\.agents|candidateId|--run|\bbegin\b|\bcontext\b|\bdecide\b/i.test(scenario.prompt));
    const {project, config, sources} = prepareEvaluation(parent, scenario.id, scenario, frozenRoot);
    const initialized = invoke(project, ['init']);assert(initialized.verificationConfigured);
    assert(!fs.existsSync(path.join(project, '.terse/runs')));
    cases.find(item => item.id === scenario.id).variants.find(item => ['reuse', 'cleanup'].includes(item.id)).edit(sources);
    const env = {...process.env};delete env.NODE_TEST_CONTEXT;
    const log = execFileSync(process.execPath, config.verification[0].args, {cwd: project, env, encoding: 'utf8'});
    assert.match(log, /tests 3\b/);assert.match(log, /fail 0\b/);
  });
});

test('skill observer binds installed file reads, pre-edit decisions and full final verification to actual snapshots', t => {
  const {observer, options} = observedWorkflow(t);
  const workflow = skillWorkflow(observer.observations, options);
  assert.equal(workflow.completed, true);assert.equal(workflow.evidence.decisionSequence, 2);
  assert.equal(workflow.evidence.firstEditSequence, 3);assert.equal(workflow.evidence.finalCheckSequence, 4);
  assert(observer.observations[3].sourceEdits.every(item => item.path.startsWith('src/')));
});

test('workflow grading cannot credit self-reports, late decisions, repeated baselines or stale/partial checks', t => {
  const {observer, options, project} = observedWorkflow(t), original = observer.observations;
  const variants = [
    trace => trace.forEach(item => item.skillRead = false),
    trace => trace.slice(0, 3).forEach(item => item.runStates.forEach(run => run.decided = false)),
    trace => trace[1].responses.forEach(item => item.snapshotHash = 'edited-before-begin'),
    trace => trace[4].responses.forEach(item => item.snapshotHash = 'stale-check'),
    trace => trace[4].responses.forEach(item => item.verification = []),
    trace => trace[4].responses.forEach(item => item.verification[0].status = 'failed'),
    trace => trace[4].runStates.push({run: 'another-baseline'}),
    trace => trace[2].tampered.push('terse.config.json'),
    // A decision and edit in one observed command lacks an unchanged checkpoint.
    trace => {trace[2].sourceHash = options.finalHash;},
  ];
  for (const change of variants) {
    const trace = structuredClone(original);change(trace);
    assert.equal(skillWorkflow(trace, options).completed, false);
  }
  assert.equal(skillWorkflow(original, {...options, traceComplete: false}).completed, false);
  assert.equal(skillWorkflow(original, {...options, removals: [{path: 'src/legacy.ts'}]}).completed, false);
  const observerOnly = skillObserver(project, {});
  observerOnly.observe({type: 'item.completed', item: {id: 'claim', type: 'agent_message', text: 'I used the skill and ran all checks.'}});
  assert.deepEqual(observerOnly.observations, []);
});

test('parent observer retains restored protection edits as invalid evidence', t => {
  const {observer, project, options} = observedWorkflow(t);
  const file = path.join(project, 'test/orders.test.mjs'), original = fs.readFileSync(file);
  fs.appendFileSync(file, '\n// changed protection\n');observer.observe(command('tamper', ''));
  fs.writeFileSync(file, original);observer.observe(command('restore', ''));
  assert(observer.observations.at(-2).tampered.includes('test/orders.test.mjs'));
  assert.equal(observer.observations.at(-1).tampered.length, 0);
  assert.equal(skillWorkflow(observer.observations, options).completed, false);
});

test('a final failed, missing or foreign check withholds credit until a later full success', t => {
  const {observer, project, options, begun, checked} = observedWorkflow(t);
  const original = structuredClone(observer.observations);
  const instruction = `node .agents/skills/terse/scripts/run.mjs check --run ${begun.run} --summary --json`;
  const attempts = [
    {output: {schemaVersion: 1, command: 'check', outputKind: 'error', status: 'incomplete', exitCode: 3, errors: ['failed to load run']}, command: instruction},
    {output: '', command: instruction},
    {output: JSON.stringify(checked) + '\n{"schemaVersion":1', command: instruction + '; ' + instruction},
    {output: {...checked, run: 'other-run'}, command: instruction},
  ];
  for (const attempt of attempts) {
    const live = skillObserver(project, {});live.observations.push(...structuredClone(original));
    live.observe(command('last-attempt', attempt.output, attempt.command));
    assert.equal(skillWorkflow(live.observations, options).fullFinalCheck, false);
    assert.equal(skillWorkflow(live.observations, options).completed, false);
    live.observe(command('recovered', checked, instruction));
    assert.equal(skillWorkflow(live.observations, options).completed, true);
  }
  const help = skillObserver(project, {});help.observations.push(...structuredClone(original));
  help.observe(command('help', '', instruction + ' --help'));
  assert.equal(skillWorkflow(help.observations, options).completed, true);
});

test('real transport preserves split UTF-8 JSONL and records observation errors without hiding completion', async t => {
  const parent = workspace(t), preload = path.join(parent, 'preload.mjs');
  const raw = [command('unicode', '金额验证'), {type: 'turn.completed'}].map(item => JSON.stringify(item)).join('\n') + '\n';
  const breakAt = Buffer.from(raw).indexOf(Buffer.from('金额')) + 1;
  fs.writeFileSync(preload, `const raw=Buffer.from(${JSON.stringify(raw)});process.stdout.write(raw.subarray(0,${breakAt}));
await new Promise(resolve=>setTimeout(resolve,20));process.stdout.write(raw.subarray(${breakAt}));await new Promise(resolve=>setTimeout(resolve,20));process.exit(0);`);
  const seen = [];
  const result = await runAgent({project: parent, prompt: 'Transport fixture, no model.', directory: parent, codex: process.execPath,
    specification: {model: 'unused', reasoningEffort: 'medium', timeoutMs: 5000}, env: {...process.env, NODE_OPTIONS: `--import="${pathToFileURL(preload).href}"`},
    onEvent: event => {seen.push(event);if(event.type === 'turn.completed') throw Error('observation fixture error');}});
  assert.equal(result.exitCode, 0);assert.equal(result.events.completed, true);assert.equal(result.timedOut, false);
  assert.equal(seen[0].item.aggregated_output, '金额验证');assert.deepEqual(result.observationErrors, ['observation fixture error']);
  assert.equal(fs.readFileSync(path.join(parent, 'agent.jsonl'), 'utf8'), raw);
});

test('skill summaries retain missing workflows and behavioral failures instead of selecting successes', () => {
  const sample = {artifactId: 'modify-session-1', evidence: {patchHash: 'patch'}, protocolValid: true, correct: true,
    workflow: {skillReadObserved: true, beginBeforeEdit: true, retrievalBeforeEdit: true, decisionBeforeEdit: true, fullFinalCheck: true, completed: false}};
  const reviews = [{artifactId: sample.artifactId, patchHash: 'patch', duplicateFree: true, cleanupComplete: true, reason: 'Inspected the exporter delegation.'}];
  const summary = skillSummary([sample], reviews);assert.equal(summary.functional, 1);assert.equal(summary.workflowCompleted, 0);
  assert.equal(skillSummary([{...sample, correct: false}], reviews).functional, 0);
  assert.equal(skillSummary([{...sample, protocolValid: false}], reviews).functional, 0);
  assert.throws(() => skillSummary([sample], []));assert.throws(() => skillSummary([sample], [{...reviews[0], patchHash: 'other'}]));
});

test('skill exporter preserves incomplete sessions, verifies hashes and refuses overwriting cohorts', t => {
  const parent = workspace(t), source = path.join(parent, 'raw'), target = path.join(parent, 'published'), archive = path.join(parent, 'archive');
  const {observer, options, project, checked} = observedWorkflow(t);
  const id = 'modify-session-1', directory = path.join(source, id);fs.mkdirSync(directory, {recursive: true});
  fs.cpSync(project, path.join(directory, 'project'), {recursive: true});
  const files = {'implementation.patch': '', 'agent.jsonl': '{}\n', 'prompt.txt': 'ordinary requirement', 'initialization.json': '{}\n',
    'observations.json': JSON.stringify(observer.observations) + '\n', 'analysis.json': '{}\n'};
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), content);
  const fixture = 'examples/orders/src/orders.ts';
  const evidence = Object.fromEntries([['patchHash','implementation.patch'],['eventHash','agent.jsonl'],['promptHash','prompt.txt'],['initializationHash','initialization.json'],['observationsHash','observations.json'],['analysisHash','analysis.json']].map(([key, file]) => [key, hash(files[file])]));
  const result = {artifactId: id, taskId: 'modify', repetition: 1, baselineHash: options.initialHash, snapshotHash: options.finalHash,
    promptHash: evidence.promptHash, correct: false, protocolValid: false, verification: options.verification, workflow: skillWorkflow(observer.observations, {...options, traceComplete: false}),
    observationErrors: [], events: {completed: false, errors: [], finalMessage: 'local prose'}, evidence};
  write(path.join(source, 'report.json'), {kind: 'agent-skill-integration', terseRevision: 'a'.repeat(40), repetitions: 1,
    tasks: [{id: 'modify', promptHash: result.promptHash, remove: []}], fixtureHashes: hashFiles(repository, [fixture]), results: [result]});
  write(path.join(source, 'reviews.json'), [{artifactId: id, patchHash: evidence.patchHash, duplicateFree: true, cleanupComplete: true, reason: 'Inspected source.'}]);
  fs.unlinkSync(path.join(directory, 'project/terse.config.json'));
  fs.appendFileSync(path.join(directory, 'implementation.patch'), 'altered');
  assert.throws(() => exportSkillBenchmark(source, target, archive));assert.equal(fs.existsSync(target), false);
  fs.writeFileSync(path.join(directory, 'implementation.patch'), '');
  const published = exportSkillBenchmark(source, target, archive);assert.equal(published.summary.sessions, 1);
  assert.equal(published.summary.functional, 0);assert.equal(published.summary.workflowCompleted, 0);
  const reportBytes = fs.readFileSync(path.join(target, 'report.json'));
  assert(!JSON.parse(reportBytes).results[0].events.finalMessage);
  assert.throws(() => exportSkillBenchmark(source, target, archive));
  assert.deepEqual(fs.readFileSync(path.join(target, 'report.json')), reportBytes);
});
