import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pqueueCases, pqueueCommands, installPqueueAcceptance, pqueueFixture} from '../scripts/lib/pqueue-skill.mjs';
import {prepareOpenSourceProject} from '../scripts/lib/open-source-project.mjs';
import {hashFiles, scopeHash, skillObserver, skillWorkflow} from '../scripts/lib/skill-evidence.mjs';
import {verifyCommand} from '../scripts/lib/benchmark-project.mjs';
import {invoke} from '../scripts/lib/workspace.mjs';
import {snapshot} from '../dist/project.js';

function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-pqueue-skill-'));
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('terse-pqueue-skill-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });return parent;
}
function prepared(t) {
  const parent = workspace(t), source = path.join(parent, 'upstream');fs.mkdirSync(path.join(source, 'source'), {recursive: true});
  fs.mkdirSync(path.join(source, 'node_modules/fixture'), {recursive: true});
  fs.writeFileSync(path.join(source, 'node_modules/fixture/value'), 'original dependency');
  const files = {'.gitignore': 'node_modules/\n', 'package.json': '{"type":"module"}', 'readme.md': 'Original docs\n', 'source/index.ts': 'export function waiting() {return 1;}\n'};
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(source, file), content);
  const editable = ['source/index.ts', 'readme.md'];
  const result = prepareOpenSourceProject({source, directory: path.join(parent, 'session with spaces'), files: Object.keys(files), dependencyLock: Buffer.from('{}'), task: {editable}, specification: {exclude: ['acceptance']},
    commands: {behavior: ['--test', 'acceptance/test.mjs']}, setup(project) {
      fs.mkdirSync(path.join(project, 'acceptance'));fs.writeFileSync(path.join(project, 'acceptance/test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';import {waiting} from '../source/index.ts';test('behavior',()=>assert.equal(waiting(),1));`);
    }});
  return {...result, source, parent, editable};
}
const event = (id, output) => ({type: 'item.completed', item: {id, type: 'command_execution', command: 'node cli.js', aggregated_output: JSON.stringify(output), exit_code: 0}});

test('p-queue Skill prompts contain business requirements without workflow hints and retain four checks', t => {
  const parent = workspace(t);
  assert.deepEqual(pqueueCases.map(task => task.id), ['modify', 'delete', 'refactor']);
  for (const task of pqueueCases) {
    assert(!/terse|skill|AGENTS|candidateId|--run|\bbegin\b|\bdecide\b/i.test(task.prompt));
    const project = path.join(parent, task.id);fs.mkdirSync(project);
    installPqueueAcceptance(project, task);
    assert.deepEqual(fs.readFileSync(path.join(project, 'acceptance', task.acceptance)), fs.readFileSync(path.join(pqueueFixture, task.acceptance)));
    assert.equal(fs.readFileSync(path.join(project, 'acceptance', task.typeAcceptance), 'utf8'), fs.readFileSync(path.join(pqueueFixture, task.typeAcceptance), 'utf8').replaceAll('./project/', '../'));
    const commands = pqueueCommands(task);
    assert.deepEqual(Object.keys(commands), ['build', 'acceptance', 'upstream', 'types']);
    assert(commands.build.includes('--noEmit'));assert(commands.acceptance.includes('--import=tsx/esm'));
    assert(commands.types.includes('--strict'));assert(commands.upstream.includes('node_modules/ava/entrypoints/cli.mjs'));
  }
});

test('shared open-source preparation copies dependencies privately and leaves no host task run', t => {
  const p = prepared(t);
  assert.equal(fs.existsSync(path.join(p.project, '.terse/runs')), false);
  assert.equal(p.config.verification.length, 1);assert.equal(p.before.hash, snapshot(p.project).hash);
  fs.writeFileSync(path.join(p.project, 'node_modules/fixture/value'), 'changed copy');
  assert.equal(fs.readFileSync(path.join(p.source, 'node_modules/fixture/value'), 'utf8'), 'original dependency');
  assert.equal(invoke(p.project, ['init']).verificationConfigured, true);
  assert.equal(fs.existsSync(path.join(p.project, '.terse/runs')), false);
});

test('scope snapshots detect documentation edits before deciding even when source hash stays unchanged', t => {
  const p = prepared(t);invoke(p.project, ['init']);
  const initialHash = snapshot(p.project).hash, initialScopeHash = scopeHash(p.project, p.editable);
  const observer = skillObserver(p.project, hashFiles(p.project, ['terse.config.json']), {editable: p.editable});
  const begun = invoke(p.project, ['begin', '--task', 'Extend the documented behavior', '--query', 'waiting']);observer.observe(event('begin', begun));
  fs.appendFileSync(path.join(p.project, 'readme.md'), 'New behavior\n');observer.observe(event('docs', {}));
  assert.equal(snapshot(p.project).hash, initialHash);assert.notEqual(observer.observations.at(-1).scopeHash, initialScopeHash);
  const candidate = begun.context.candidates.find(item => item.symbol === 'waiting');
  observer.observe(event('late-decision', invoke(p.project, ['decide', '--run', begun.run, '--strategy', 'modify', '--candidate', candidate.candidateId, '--rationale', 'Extend this existing entry.'])));
  const grade = skillWorkflow(observer.observations, {initialHash, finalHash: initialHash, initialScopeHash, editable: p.editable, verification: p.config.verification, traceComplete: true});
  assert.equal(grade.evidence.firstEditSequence, 1);assert.equal(grade.decisionBeforeEdit, false);
  const attempted = structuredClone(observer.observations[0]);attempted.sourceEdits = [{path: 'source/index.ts', kind: 'update'}];
  const early = skillWorkflow([attempted, ...observer.observations.map(item => ({...item, sequence: item.sequence + 1}))], {initialHash, finalHash: initialHash,
    editable: p.editable, verification: p.config.verification, traceComplete: true});
  assert.equal(early.beginBeforeEdit, false);
});

test('verification rejects a zero-test success and wrong test counts while retaining full output hashes', t => {
  const p = prepared(t), env = {...process.env};delete env.NODE_TEST_CONTEXT;
  const good = verifyCommand(p.project, 'good', p.config.verification[0].args, p.parent, {env, expectedTests: 1});
  assert.equal(good.passed, true);assert.equal(good.testCounts.tests, 1);
  const wrong = verifyCommand(p.project, 'wrong', p.config.verification[0].args, p.parent, {env, expectedTests: 2});
  assert.equal(wrong.exitCode, 0);assert.equal(wrong.passed, false);
  const empty = verifyCommand(p.project, 'empty', ['-e', 'console.log("No tests ran")'], p.parent, {env, expectedTests: 1});
  assert.equal(empty.exitCode, 0);assert.equal(empty.passed, false);assert.match(empty.logHash, /^[a-f0-9]{64}$/);
});

test('a README edit after a passing check needs a new final scope checkpoint', t => {
  const p = prepared(t);invoke(p.project, ['init']);
  const initialHash = snapshot(p.project).hash, initialScopeHash = scopeHash(p.project, p.editable);
  const observer = skillObserver(p.project, {}, {editable: p.editable});
  observer.observe({type: 'item.completed', item: {id: 'read', type: 'command_execution', command: 'Get-Content SKILL.md', aggregated_output: fs.readFileSync(path.join(p.project, '.agents/skills/terse/SKILL.md'), 'utf8')}});
  const begun = invoke(p.project, ['begin', '--task', 'Extend waiting', '--query', 'waiting']);observer.observe(event('begin', begun));
  const candidate = begun.context.candidates.find(item => item.symbol === 'waiting');
  observer.observe(event('decision', invoke(p.project, ['decide', '--run', begun.run, '--strategy', 'modify', '--candidate', candidate.candidateId, '--rationale', 'Extend the existing function.'])));
  fs.writeFileSync(path.join(p.project, 'source/index.ts'), 'export function waiting(value = 1) {return value;}\n');observer.observe(event('implementation', {}));
  observer.observe(event('check', invoke(p.project, begun.verificationGuide.argvTemplate)));
  const options = {initialHash, initialScopeHash, finalHash: snapshot(p.project).hash, finalScopeHash: scopeHash(p.project, p.editable),
    editable: p.editable, verification: p.config.verification, traceComplete: true};
  assert.equal(skillWorkflow(observer.observations, options).completed, true);
  fs.appendFileSync(path.join(p.project, 'readme.md'), 'New parameter\n');observer.observe(event('docs', {}));
  options.finalScopeHash = scopeHash(p.project, p.editable);
  assert.equal(skillWorkflow(observer.observations, options).fullFinalCheck, false);
  observer.observe(event('recheck', invoke(p.project, begun.verificationGuide.argvTemplate)));
  assert.equal(skillWorkflow(observer.observations, options).completed, true);
});
