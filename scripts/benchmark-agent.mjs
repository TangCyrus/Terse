import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { repository } from './lib/workspace.mjs';
import { summarizeEvents, pairedSummary } from './lib/agent-events.mjs';
import { begin, rootOf, snapshot } from '../dist/project.js';
import { clones, newClones } from '../dist/analyze.js';

const { values } = parseArgs({ options: { source: { type: 'string' }, codex: { type: 'string', default: 'codex' }, repetitions: { type: 'string' }, workflow: { type: 'string', default: 'manual' } } });
assert(['manual', 'commands'].includes(values.workflow), '--workflow must be manual or commands');
assert(values.source, 'Pass --source <clean p-map checkout with installed development dependencies>');
const source = fs.realpathSync(values.source);
const fixture = path.join(repository, 'benchmarks/p-map');
const specification = JSON.parse(fs.readFileSync(path.join(fixture, 'project.json'), 'utf8'));
const repetitions = Number(values.repetitions ?? specification.repetitions);
assert(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 10);
const digest = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
assert.equal(git('-C', source, 'rev-parse', 'HEAD').trim(), specification.commit);
execFileSync('git', ['-C', source, 'diff', '--exit-code'], { stdio: 'pipe' });
const files = git('-C', source, 'ls-files', '-z').split('\0').filter(Boolean);
assert(fs.existsSync(path.join(source, 'node_modules/ava/entrypoints/cli.mjs')), 'Install upstream development dependencies first');
assert(fs.existsSync(path.join(source, 'package-lock.json')), 'Prepare with npm install --ignore-scripts --package-lock=true');
const dependencyLock = fs.readFileSync(path.join(source, 'package-lock.json'));
fs.mkdirSync(path.join(repository, '.terse'), { recursive: true });
const output = fs.mkdtempSync(path.join(repository, '.terse/agent-benchmark-'));
fs.writeFileSync(path.join(output, 'package-lock.json'), dependencyLock);
const cliVersion = execFileSync(values.codex, ['--version'], { encoding: 'utf8' }).trim();
const task = fs.readFileSync(path.join(fixture, 'task.md'), 'utf8');
const acceptance = path.join(fixture, 'acceptance.mjs');
const terseCli = path.join(repository, 'dist/cli.js');
const results = [];
const env = { ...process.env, FORCE_COLOR: '0' };
delete env.NODE_TEST_CONTEXT;
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

function verify(project, label, args, directory) {
  const start = performance.now();
  const check = spawnSync(process.execPath, args, { cwd: project, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  fs.writeFileSync(path.join(directory, `${label}.log`), `${check.stdout ?? ''}\n${check.stderr ?? ''}`);
  return { exitCode: check.status, error: check.error?.message ?? null, passed: check.status === 0 && !check.error, elapsedMs: Math.round(performance.now() - start) };
}

async function runAgent(project, prompt, directory) {
  const args = ['exec', '--ephemeral', '--approve-for-me',
    '--disable', 'multi_agent', '--json', '--color', 'never', '-m', specification.model,
    '-c', `model_reasoning_effort="${specification.reasoningEffort}"`, '-C', project, '-'];
  fs.writeFileSync(path.join(directory, 'prompt.txt'), prompt);
  const start = performance.now();
  const stdout = fs.createWriteStream(path.join(directory, 'agent.jsonl'));
  const stderr = fs.createWriteStream(path.join(directory, 'agent.stderr.log'));
  const child = spawn(values.codex, args, { cwd: project, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  let timedOut = false;
  const heartbeat = setInterval(() => console.error(`Agent still running: ${path.basename(directory)} (${Math.round((performance.now() - start) / 1000)}s)`), 30_000);
  const timeout = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGKILL');
  }, specification.timeoutMs);
  const exit = await new Promise(resolve => {
    child.once('error', error => resolve({ exitCode: null, error: error.message }));
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timeout); clearInterval(heartbeat);
  await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
  const events = summarizeEvents(fs.readFileSync(path.join(directory, 'agent.jsonl'), 'utf8'));
  const blockedByPolicy = /blocked by policy/.test(fs.readFileSync(path.join(directory, 'agent.stderr.log'), 'utf8'));
  return { ...exit, timedOut, blockedByPolicy, agentMs: Math.round(performance.now() - start), events };
}

// Verify the upstream start before any model is called. Missing task API must fail acceptance.
const preflight = { upstream: verify(source, 'upstream-before', ['node_modules/ava/entrypoints/cli.mjs'], output),
  taskBefore: verify(source, 'acceptance-before', ['--test', acceptance], output) };
assert(preflight.upstream.passed, 'Upstream baseline tests must pass');
assert(!preflight.taskBefore.passed, 'Acceptance must fail before implementing the task');
write(path.join(output, 'plan.json'), { ...specification, repetitions, workflow: values.workflow, cliVersion, execution: 'workspace-write with automatic approval; preserve local Windows/proxy configuration', taskHash: digest(task),
  acceptanceHash: digest(fs.readFileSync(acceptance)), dependencyLockHash: digest(dependencyLock), preflight });

for (let repetition = 1; repetition <= repetitions; repetition++) {
  const arms = repetition % 2 ? ['control', 'terse'] : ['terse', 'control'];
  for (const arm of arms) {
    const directory = path.join(output, `pair-${repetition}-${arm}`);
    const project = path.join(directory, 'project');
    fs.mkdirSync(project, { recursive: true });
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      fs.copyFileSync(path.join(source, file), path.join(project, file));
    }
    fs.writeFileSync(path.join(project, 'package-lock.json'), dependencyLock);
    fs.cpSync(path.join(source, 'node_modules'), path.join(project, 'node_modules'), { recursive: true });
    fs.appendFileSync(path.join(project, '.gitignore'), '\n.terse/\n');
    execFileSync('git', ['init', '-q'], { cwd: project });
    execFileSync('git', ['add', '.'], { cwd: project, stdio: 'pipe' });
    const root = rootOf(project);
    fs.copyFileSync(path.join(fixture, 'acceptance-types.mts'), path.join(directory, 'acceptance-types.mts'));
    const typeArguments = ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022', '../acceptance-types.mts'];
    const config = { exclude: ['test.js', 'index.test-d.ts'], minTokens: 50, minLines: 5, duplicatePolicy: 'review',
      verification: [{ command: 'node', args: ['--test', acceptance], timeoutMs: 60_000 },
        { command: 'node', args: ['node_modules/ava/entrypoints/cli.mjs'], timeoutMs: 120_000 },
        { command: 'node', args: typeArguments, timeoutMs: 60_000 }] };
    fs.writeFileSync(path.join(root, 'terse.config.json'), JSON.stringify(config, null, 2));
    const protectedFiles = [...files.filter(file => !specification.editable.includes(file)), 'terse.config.json', 'package-lock.json'];
    const protectedHashes = Object.fromEntries(protectedFiles.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
    const before = snapshot(root);
    const run = begin(root, task);
    const common = `${task}\n\nWorking directory: ${root}\nAcceptance: node --test ${JSON.stringify(acceptance)}\nUpstream runtime suite: node node_modules/ava/entrypoints/cli.mjs\nType acceptance: node ${typeArguments.join(' ')}\nYou may read the supplied external acceptance files, and the Terse CLI when provided, but no other experiment artifacts.\nTime limit: ${specification.timeoutMs / 1000} seconds.\n`;
    const recordInstructions = values.workflow === 'commands'
      ? `Read the candidates and their candidateId. Save your actual decision with node ${JSON.stringify(terseCli)} decide --cwd ${JSON.stringify(root)} --run ${run.run} --strategy <reuse|modify|refactor|new> --rationale "<your reasoning>" --candidate <candidateId> --json. Do not hand-edit decision.json or guess record fields; the command validates and writes the record. Use --input only for complex multi-candidate decisions. Then implement.`
      : `Read the candidates, complete ${JSON.stringify(run.decisionPath)} with your actual strategy and considered candidates, then implement.`;
    const treatment = arm === 'terse' ? `\nUse the supplied Terse CLI before editing: node ${JSON.stringify(terseCli)} context --cwd ${JSON.stringify(root)} --run ${run.run} --query "pMap concurrency mapper skip abort" --limit 10 --json. ${recordInstructions} Before finishing run node ${JSON.stringify(terseCli)} check --cwd ${JSON.stringify(root)} --run ${run.run}${values.workflow === 'commands' ? ' --summary' : ''} --json, inspect findings, and resolve duplication where appropriate within the same time limit. Explain unresolved findings honestly.\n`
      : '\nWork normally using project source and the supplied tests. Do not invoke Terse or read .terse records.\n';
    console.error(`Starting pair ${repetition}, ${arm}`);
    const agent = await runAgent(root, common + treatment, directory);
    const tampered = protectedFiles.filter(file => !fs.existsSync(path.join(root, file)) || digest(fs.readFileSync(path.join(root, file))) !== protectedHashes[file]);
    const checkStart = performance.now();
    const checks = { acceptance: verify(root, 'acceptance', ['--test', acceptance], directory),
      upstream: verify(root, 'upstream', ['node_modules/ava/entrypoints/cli.mjs'], directory),
      types: verify(root, 'types', typeArguments, directory) };
    let newDuplications = null, duplicationError = null;
    try {
      const after = snapshot(root);
      const findings = newClones(before, after, await clones(after));
      newDuplications = findings.length;
      write(path.join(directory, 'duplications.json'), findings);
    } catch (error) { duplicationError = error.message; }
    const changed = git('-C', root, 'diff', '--name-only').trim().split(/\r?\n/).filter(Boolean);
    const untracked = git('-C', root, 'ls-files', '--others', '--exclude-standard').trim().split(/\r?\n/).filter(Boolean);
    const outsideScope = [...changed, ...untracked].filter(file => !specification.editable.includes(file) && file !== 'terse.config.json' && file !== 'package-lock.json');
    const patch = execFileSync('git', ['-C', root, 'diff', '--binary'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(directory, 'implementation.patch'), patch);
    let workflow = arm === 'control' ? null : false;
    if (arm === 'terse') {
      try {
        const runPath = path.dirname(run.decisionPath);
        const history = JSON.parse(fs.readFileSync(path.join(runPath, 'context.json'), 'utf8'));
        const report = JSON.parse(fs.readFileSync(path.join(runPath, 'report.json'), 'utf8'));
        const decision = JSON.parse(fs.readFileSync(run.decisionPath, 'utf8'));
        workflow = history.some(entry => entry.atBaseline && entry.snapshotHash === before.hash && entry.errors.length === 0)
          && decision.rationale?.trim().length > 0 && decision.considered?.length > 0
          && report.snapshotHash === snapshot(root).hash;
      } catch { /* Missing or stale workflow evidence remains false. */ }
    }
    const controlUsedTerse = arm === 'control' && ['context.json', 'report.json'].some(file => fs.existsSync(path.join(path.dirname(run.decisionPath), file)));
    const result = { repetition, arm, baselineHash: before.hash, acceptanceHash: digest(fs.readFileSync(acceptance)),
      agentMs: agent.agentMs, evaluationMs: Math.round(performance.now() - checkStart), agentExitCode: agent.exitCode,
      timedOut: agent.timedOut, blockedByPolicy: agent.blockedByPolicy, controlUsedTerse, events: agent.events, checks, workflow, tampered, outsideScope,
      protocolValid: agent.exitCode === 0 && !agent.timedOut && !agent.blockedByPolicy && agent.events.completed && agent.events.commandCount > 0 && !controlUsedTerse && tampered.length === 0 && outsideScope.length === 0 && !duplicationError && (arm === 'control' || workflow),
      correct: Object.values(checks).every(check => check.passed) && tampered.length === 0,
      newDuplications, duplicationError, changed,
      evidence: { patchHash: digest(patch), eventHash: digest(fs.readFileSync(path.join(directory, 'agent.jsonl'))) } };
    results.push(result);
    write(path.join(directory, 'result.json'), result);
    write(path.join(output, 'progress.json'), results);
    console.error(`Finished pair ${repetition}, ${arm}: correct=${result.correct}, duplicates=${newDuplications}, protocol=${result.protocolValid}`);
  }
}
const summary = { schemaVersion: 1, kind: 'open-source-agent-comparison', project: specification,
  repetitions, workflow: values.workflow, cliVersion, runtime: { node: process.version, platform: process.platform, arch: process.arch },
  terseRevision: git('-C', repository, 'rev-parse', 'HEAD').trim(), taskHash: digest(task),
  acceptanceHash: digest(fs.readFileSync(acceptance)), typeAcceptanceHash: digest(fs.readFileSync(path.join(fixture, 'acceptance-types.mts'))), dependencyLockHash: digest(dependencyLock), preflight,
  results, pairs: pairedSummary(results), artifactDirectory: output };
write(path.join(output, 'comparison.json'), summary);
console.log(JSON.stringify(summary, null, 2));
