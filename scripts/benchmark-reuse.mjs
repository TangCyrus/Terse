import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {cases as functionalCases} from './evaluation-cases.mjs';
import {challenges} from './challenge-cases.mjs';
import {repository} from './lib/workspace.mjs';
import {prepareEvaluation, analyzeEvaluation} from './lib/evaluation-project.mjs';
import {runAgent} from './lib/agent-runner.mjs';
import {pairedSummary, correctionEvidence} from './lib/agent-events.mjs';
import {collectChanges, protectedFileEvidence} from './lib/benchmark-project.mjs';
import {begin, snapshot} from '../dist/project.js';
import {context, indexSources} from '../dist/analyze.js';
import {decisionGuide, validateDecision} from '../dist/decision.js';
import {verificationGuide} from '../dist/output.js';

const {values} = parseArgs({options: {codex: {type: 'string', default: 'codex'}, repetitions: {type: 'string', default: '1'}, suite: {type: 'string', default: 'functional'}, 'preflight-only': {type: 'boolean'}}});
assert(['functional', 'challenge'].includes(values.suite));
const cases = values.suite === 'challenge' ? challenges : functionalCases;
const repetitions = Number(values.repetitions);
assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
const specification = {fixture: 'examples/orders + examples/evaluation', model: 'gpt-6.1-sol', reasoningEffort: 'medium', timeoutMs: 600_000};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const hashFiles = (root, files) => Object.fromEntries(files.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
const list = (root, directory = '') => fs.readdirSync(path.join(root, directory), {withFileTypes: true}).flatMap(entry => {
  const relative = path.posix.join(directory, entry.name);
  return ['.git', '.terse', 'node_modules'].includes(entry.name) ? [] : entry.isDirectory() ? list(root, relative) : [relative];
}).sort();
const env = {...process.env, FORCE_COLOR: '0'};
delete env.NODE_TEST_CONTEXT;
const terseRevision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim();
const terseCli = path.join(repository, 'dist/cli.js');
fs.mkdirSync(path.join(repository, '.terse'), {recursive: true});
const output = fs.mkdtempSync(path.join(repository, '.terse/reuse-agent-'));
const cliVersion = execFileSync(values.codex, ['--version'], {encoding: 'utf8', env}).trim();
const sourceFiles = [...list(path.join(repository, 'examples/orders')).map(file => `examples/orders/${file}`),
  ...list(path.join(repository, 'examples/evaluation')).map(file => `examples/evaluation/${file}`),
  'scripts/evaluation-cases.mjs', 'scripts/lib/evaluation-project.mjs',
  ...(values.suite === 'challenge' ? [...list(path.join(repository, 'examples/challenge')).map(file => `examples/challenge/${file}`),
    'scripts/challenge-cases.mjs', 'scripts/benchmark-reuse.mjs', 'scripts/lib/agent-events.mjs'] : [])];
const fixtureHashes = hashFiles(repository, sourceFiles);
const tasks = cases.map(({id, task, remove, candidate, acceptance, mode, targetRules}) => ({id, task, remove: remove ?? [], candidate: candidate ?? null,
  ...(mode ? {mode, targetRules} : {}),
  // Search terms come from the requirement, not from the authored candidate oracle.
  query: task, acceptanceHash: digest(fs.readFileSync(path.join(repository, acceptance ?? `examples/evaluation/${id}.test.mjs`)))}));
// Allow new source modules equally in both arms; forbidding copies by filename would bias reuse.
const editable = ['src/'];
function prepare(task, label) {
  const scenario = cases.find(item => item.id === task.id);
  const {project, config, sources} = prepareEvaluation(output, path.join(label, 'project'), scenario);
  execFileSync('git', ['add', '.'], {cwd: project, stdio: 'pipe'});
  const before = snapshot(project);
  assert.deepEqual(indexSources(before, project).errors, []);
  assert.deepEqual(collectChanges(project, editable).changed, []);
  return {project, config, before, sources, scenario};
}
function verify(project, config, directory) {
  const result = spawnSync(process.execPath, config.verification[0].args, {cwd: project, env, encoding: 'utf8', timeout: 30_000});
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  fs.writeFileSync(path.join(directory, 'acceptance.log'), log);
  return {passed: !result.error && result.status === 0 && /tests 3\b/.test(log), exitCode: result.status,
    error: result.error?.message ?? null, logHash: digest(log)};
}
// Runtime acceptance alone intentionally cannot detect the retained legacy body.
const preflight = tasks.map(task => {
  const {project, config, sources, scenario} = prepare(task, `preflight-${task.id}`);
  scenario.seed?.(sources);
  const verification = verify(project, config, path.dirname(project));
  assert.equal(verification.passed, scenario.preflightPass ?? task.id === 'delete');
  return {taskId: task.id, verification};
});
const plan = {schemaVersion: 1, kind: 'controlled-agent-comparison', suite: values.suite, terseRevision, project: specification, repetitions, cliVersion,
  tasks, fixtureHashes, preflight, criteria: 'Behavior correctness, patch-reviewed reuse/cleanup and independent-responsibility preservation. Token counts and elapsed time alone are not success criteria.'};
write(path.join(output, 'plan.json'), plan);
if (values['preflight-only']) { console.log(JSON.stringify({output, preflight}, null, 2)); process.exit(0); }
const results = [];
for (const [taskIndex, task] of tasks.entries()) for (let repetition = 1; repetition <= repetitions; repetition++) {
  for (const arm of (taskIndex + repetition) % 2 ? ['control', 'terse'] : ['terse', 'control']) {
    const artifactId = `${task.id}-pair-${repetition}-${arm}`;
    const {project, config, before, sources, scenario} = prepare(task, artifactId);
    const directory = path.dirname(project);
    const protectedHashes = hashFiles(project, list(project).filter(file => !file.startsWith('src/')));
    const run = begin(project, task.task);
    // Retrieve against the actual baseline before applying inherited WIP.
    const preparedContext = arm === 'terse' && scenario.seed ? {...context(project, run.run, task.query, 10),
      decisionGuide: decisionGuide(project, run.run), verificationGuide: verificationGuide(project, run.run)} : null;
    scenario.seed?.(sources);
    let initial = null;
    if (task.mode) {
      const analysis = await analyzeEvaluation(project, before, task.remove);
      assert.equal(analysis.duplicationError, null);
      initial = {snapshotHash: analysis.after.hash, newDuplications: analysis.newDuplications, possibleDuplications: analysis.possibleDuplications,
        similarities: analysis.similarities, cleanup: analysis.cleanup};
      if (scenario.seed) assert(task.targetRules.some(rule => analysis.similarities.some(item => item.rule === rule)
        || analysis.cleanup.some(item => item.rule === rule)), 'Seed must expose its preregistered problem before any model call');
      const patch = collectChanges(project, editable).patch;
      fs.writeFileSync(path.join(directory, 'initial.patch'), patch);
      write(path.join(directory, 'initial-analysis.json'), initial);
    }
    const command = `node ${config.verification[0].args.join(' ')}`;
    const common = `${task.task}\nImplement the API/behavior shown by test/acceptance.test.mjs, preserving the original tests. Preserve compatibility and avoid parallel implementations. Independent responsibilities may be added; do not force unrelated behavior into an existing API.\nWorking directory: ${project}\nOnly edit the src/ source tree; new source modules are allowed. Do not change tests, config, dependencies or other files. Do not commit/push, invoke other agents, use web search, or read other experiment directories. You may read the supplied tests. Report unresolved issues honestly. Time limit: ${specification.timeoutMs / 1000} seconds.\n`;
    const retrieval = preparedContext ? `The host recorded this genuine baseline context BEFORE the inherited edits; use its candidate IDs and guides rather than backdating a new search: ${JSON.stringify(preparedContext)}.`
      : `Use Terse before editing: node ${JSON.stringify(terseCli)} context --cwd ${JSON.stringify(project)} --run ${run.run} --query ${JSON.stringify(task.query)} --limit 10 --json.`;
    const inherited = scenario.seed ? 'The working tree contains inherited, uncommitted work. Inspect that diff before completing the task. ' : '';
    const checkpoint = scenario.seed ? 'After recording your decision and BEFORE editing any source, execute verificationGuide.argvTemplate with the Terse CLI to assess this inherited work. Inspect its findings, then make your own repair choices. ' : '';
    const treatment = arm === 'terse'
      ? `${inherited}${retrieval} Read candidates and decisionGuide; record your actual choice with decide using that guide before implementation. New responsibility decisions may have no selected candidates. For complex decisions use --input and the published schema, with no overriding field flags. Include these declared removals: ${JSON.stringify(task.remove)}. ${checkpoint}After implementation, execute verificationGuide.argvTemplate with node ${JSON.stringify(terseCli)}. It runs check --summary --json with the complete configured verification (${command}); do not separately repeat the full suite by default. Inspect failureOutput, errors and findings first; read reportPath if more detail is needed. Fix actual problems, then rerun the full check after relevant changes. Repeating unchanged checks cannot resolve review-only findings. Explain uncertain references instead of deleting removal declarations to obtain pass.\n`
      : `${inherited}Work normally; do not invoke Terse or read .terse records. ${scenario.seed ? 'Before editing inherited work, run the supplied behavior verification, then inspect the implementation and complete the task. Reverify after changes. ' : ''}Verify with ${command}.\n`;
    console.error(`Starting ${artifactId}`);
    const agent = await runAgent({project, prompt: common + treatment, directory, codex: values.codex, specification, terseCli, env});
    const checkStart = performance.now();
    const verification = verify(project, config, directory); // Always independent, even if the agent already checked.
    const {tampered, acceptanceHash} = protectedFileEvidence(project, protectedHashes, config.verification[0].args.slice(1));
    tampered.push(...Object.entries(fixtureHashes).filter(([file, hash]) => !fs.existsSync(path.join(repository, file)) || digest(fs.readFileSync(path.join(repository, file))) !== hash).map(([file]) => `fixture/${file}`));
    const {after, duplications, newDuplications, similarities, possibleDuplications, similarityAlgorithm, duplicationError, cleanup} = await analyzeEvaluation(project, before, task.remove);
    if (duplications !== null) write(path.join(directory, 'duplications.json'), duplications);
    if (similarities !== null) write(path.join(directory, 'similarities.json'), similarities);
    // Collect only after grading; this includes new helpers and deleted modules in the patch.
    const changes = collectChanges(project, editable);
    fs.writeFileSync(path.join(directory, 'implementation.patch'), changes.patch);
    let workflow = arm === 'control' ? null : false, candidateHit = null, terseStatus = null, terseRules = [];
    const dir = path.dirname(run.decisionPath);
    if (arm === 'terse') try {
      const history = JSON.parse(fs.readFileSync(path.join(dir, 'context.json'), 'utf8'));
      const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
      const {decision} = validateDecision(JSON.parse(fs.readFileSync(run.decisionPath, 'utf8')));
      const baselineSearch = history.filter(entry => entry.atBaseline && entry.snapshotHash === before.hash && entry.errors.length === 0);
      candidateHit = task.candidate ? baselineSearch.some(entry => entry.candidates.some(candidate => candidate.path === task.candidate.path && candidate.symbol === task.candidate.symbol)) : null;
      workflow = after !== null && baselineSearch.length > 0 && !!decision && report.snapshotHash === after.hash
        && report.verification.length === config.verification.length
        && task.remove.every(removal => decision.remove.some(actual => actual.path === removal.path && actual.symbol === removal.symbol));
      terseStatus = report.status; terseRules = report.findings.map(item => item.rule);
    } catch { /* Missing/invalid evidence is never a successful integration. */ }
    const controlUsedTerse = arm === 'control' && (agent.events.decisions.attempts > 0 || agent.events.checks.reports.length > 0 || ['context.json', 'report.json'].some(file => fs.existsSync(path.join(dir, file))));
    const correction = task.mode && arm === 'terse' ? correctionEvidence(agent.events.checks, {baselineHash: before.hash,
      startingHash: initial.snapshotHash, finalHash: after?.hash, targetRules: task.targetRules, seeded: task.mode === 'seeded',
      finalClean: !duplicationError && newDuplications === 0 && possibleDuplications === 0 && !cleanup.length,
      verificationCount: config.verification.length}) : null;
    const result = {taskId: task.id, artifactId, arm, repetition, baselineHash: before.hash,
      acceptanceHash,
      ...(initial ? {startingHash: initial.snapshotHash, snapshotHash: after?.hash ?? null, initial, correction} : {}),
      correct: verification.passed && !tampered.length, checks: {acceptance: verification}, workflow, candidateHit, terseStatus, terseRules,
      protocolValid: agent.exitCode === 0 && !agent.timedOut && !agent.blockedByPolicy && agent.events.completed && agent.events.commandCount > 0
        && !tampered.length && !changes.outsideScope.length && !duplicationError && !controlUsedTerse && (arm === 'control' || workflow)
        && !(arm === 'terse' && task.mode === 'seeded' && !correction.seededCheckpoint),
      controlUsedTerse, tampered, outsideScope: changes.outsideScope, changed: changes.changed, newDuplications,
      possibleDuplications, similarityAlgorithm, duplicationError, cleanup,
      agentMs: agent.agentMs, evaluationMs: Math.round(performance.now() - checkStart), agentExitCode: agent.exitCode, timedOut: agent.timedOut,
      blockedByPolicy: agent.blockedByPolicy, events: agent.events,
      evidence: {patchHash: digest(changes.patch), eventHash: digest(fs.readFileSync(path.join(directory, 'agent.jsonl'))),
        ...(initial ? {initialPatchHash: digest(fs.readFileSync(path.join(directory, 'initial.patch'))),
          initialAnalysisHash: digest(fs.readFileSync(path.join(directory, 'initial-analysis.json')))} : {})}};
    results.push(result);
    write(path.join(directory, 'result.json'), result);
    write(path.join(output, 'progress.json'), results);
    console.error(`Finished ${artifactId}: correct=${result.correct}, duplicates=${newDuplications}, protocol=${result.protocolValid}`);
  }
}
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim(), terseRevision, 'Repository revision changed during experiment');
const summary = {...plan,
  runtime: {node: process.version, platform: process.platform, arch: process.arch}, results, pairs: pairedSummary(results), artifactDirectory: output};
write(path.join(output, 'comparison.json'), summary);
console.log(JSON.stringify({output, runs: results.length, pairs: summary.pairs}, null, 2));
