import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {removalWorkflow, removalSummary, skillWorkflow, skillObserver, captureRunStates} from '../scripts/lib/skill-evidence.mjs';
import {createWorkspace, invoke} from '../scripts/lib/workspace.mjs';

const target = {path: 'source/index.ts', symbol: 'Queue.#onEvent'};
const verification = ['build', 'acceptance', 'upstream', 'types'].map(name => ({command: 'node', args: [name], timeoutMs: 1000}));
function trace({proactive = false, review = true} = {}) {
  const state = remove => ({run: 'task', baselineHash: 'before', retrieved: true, decided: true, decisionHash: remove.length ? 'declared' : 'empty', remove});
  const before = state(proactive ? [target] : []), after = state([target]);
  const response = (status, missing, findings) => ({command: 'check', outputKind: 'result', run: 'task', baselineHash: 'before', snapshotHash: 'after',
    status, errors: 0, verification: verification.map(command => ({command, status: 'passed'})), undeclaredRemovals: missing, findings});
  const observed = (sequence, event, itemId, runState, extra = {}) => ({sequence, event, itemId, itemType: 'command_execution', sourceHash: sequence < 3 ? 'before' : 'after',
    scopeHash: sequence < 3 ? 'initial-scope' : 'final-scope', runStates: [structuredClone(runState)], responses: [], tampered: [], sourceEdits: [], checkAttempts: 0, skillRead: false, ...extra});
  const observations = [
    observed(0, 'item.completed', 'read', {...before, decided: false}, {skillRead: true}),
    observed(1, 'item.completed', 'begin', {...before, decided: false}, {responses: [{command: 'begin', outputKind: 'result', exitCode: 0, run: 'task', snapshotHash: 'before'}]}),
    observed(2, 'item.completed', 'decide', before), observed(3, 'item.completed', 'edit', before),
  ];
  if (!proactive) observations.push(observed(4, 'item.started', 'failed', before), observed(5, 'item.completed', 'failed', before,
    {checkAttempts: 1, responses: [response('fail', [target], [{rule: 'REMOVAL_DECLARATION_MISSING', severity: 'fail'}])]}),
  observed(6, 'item.completed', 'repair', after));
  observations.push(observed(7, 'item.started', 'final', after), observed(8, 'item.completed', 'final', after, {checkAttempts: 1,
    responses: [response(review ? 'needs-review' : 'pass', [], review ? [{rule: 'REMOVAL_REFERENCE_UNCERTAIN', severity: 'review'}] : [])]}));
  const options = {initialHash: 'before', finalHash: 'after', initialScopeHash: 'initial-scope', finalScopeHash: 'final-scope', editable: ['source/'],
    removals: [target], verification, traceComplete: true, finalRunStates: [after]};
  return {observations, options};
}

test('proactive declaration and explicit final review are separate from strict pass and omission repair', () => {
  const {observations, options} = trace({proactive: true});
  const result = removalWorkflow(observations, options);
  assert.equal(result.proactiveDeclaration, true);assert.equal(result.omissionDetected, false);assert.equal(result.correctionVerified, false);
  assert.equal(result.finalDeclared, true);assert.equal(result.declarationCheckCompleted, true);assert.equal(result.finalCheckStatus, 'needs-review');
  assert.deepEqual(result.finalReviewRules, ['REMOVAL_REFERENCE_UNCERTAIN']);assert.equal(skillWorkflow(observations, options).completed, false);
  const passed = trace({proactive: true, review: false});assert.equal(skillWorkflow(passed.observations, passed.options).completed, true);
});

test('a real omission finding followed by a new declaration and full same-run check earns repair, not proactive credit', () => {
  const {observations, options} = trace();const result = removalWorkflow(observations, options);
  assert.equal(result.proactiveDeclaration, false);assert.equal(result.omissionDetected, true);assert.equal(result.declarationCorrected, true);
  assert.equal(result.correctionVerified, true);assert.equal(result.declarationCheckCompleted, true);
  assert.deepEqual(result.evidence.omissionCheckSequences, [5]);assert.equal(result.evidence.correctionSequence, 6);
  assert.equal(skillWorkflow(observations, options).decisionBeforeEdit, false);
  const noFeedback = structuredClone(observations);noFeedback[5].responses[0].findings = [];
  assert.equal(removalWorkflow(noFeedback, options).correctionVerified, false);
  const unrelated = structuredClone(observations);unrelated[5].responses[0].undeclaredRemovals = [{path: 'another.ts'}];
  assert.equal(removalWorkflow(unrelated, options).declarationCorrected, false);
});

test('final declaration credit rejects dropped targets, changed decisions, ambiguous intervals and broken latest checks', () => {
  const {observations, options} = trace();
  assert.equal(removalWorkflow(observations, {...options, finalRunStates: [{...options.finalRunStates[0], remove: [], decisionHash: 'dropped'}]}).declarationCheckCompleted, false);
  const combined = structuredClone(observations);combined.find(item => item.sequence === 7).runStates[0] = structuredClone(observations[2].runStates[0]);
  assert.equal(removalWorkflow(combined, options).correctionVerified, false);
  const noStart = observations.filter(item => item.sequence !== 7);assert.equal(removalWorkflow(noStart, options).declarationCheckCompleted, false);
  const unknown = structuredClone(observations);unknown.at(-1).responses = [];
  assert.equal(removalWorkflow(unknown, options).declarationCheckCompleted, false);
  const failed = structuredClone(observations);failed.at(-1).responses[0].status = 'fail';
  assert.equal(removalWorkflow(failed, options).declarationCheckCompleted, false);
  const wrongRun = structuredClone(observations);wrongRun.at(-1).responses[0].run = 'other';
  assert.equal(removalWorkflow(wrongRun, options).correctionVerified, false);
  assert.equal(removalWorkflow(observations, {...options, traceComplete: false}).declarationCheckCompleted, false);
  assert.equal(removalWorkflow(observations, {...options, finalScopeHash: 'later-docs'}).correctionVerified, false);
});

test('unknown intermediate checks remain visible, absent metadata is not omission-free proof and modify is not proactive deletion', () => {
  const {observations, options} = trace({proactive: true, review: false});
  const unknown = structuredClone(observations);unknown.splice(4, 0, {...structuredClone(unknown[3]), sequence: 4, checkAttempts: 1});
  const result = removalWorkflow(unknown, options);
  assert.equal(result.declarationCheckCompleted, true);assert.equal(result.checkTraceComplete, false);
  const old = structuredClone(observations);delete old.at(-1).responses[0].findings;delete old.at(-1).responses[0].undeclaredRemovals;
  assert.equal(removalWorkflow(old, options).metadataAvailable, false);assert.equal(removalWorkflow(old, options).declarationCheckCompleted, false);
  const modify = removalWorkflow(observations, {...options, removals: []});assert.equal(modify.applicable, false);assert.equal(modify.proactiveDeclaration, false);
  const summary = removalSummary([{removalWorkflow: modify}, {removalWorkflow: result}, {removalWorkflow: removalWorkflow(old, options)}]);
  assert.equal(summary.sessions, 3);assert.equal(summary.applicable, 2);assert.equal(summary.declarationChecksCompleted, 2);assert.equal(summary.checkTracesComplete, 1);
});

test('all check responses retain omission feedback even when a later check in the same command succeeds', () => {
  const {observations, options} = trace({proactive: true, review: false});
  const combined = structuredClone(observations), last = combined.at(-1);
  const failed = {...structuredClone(last.responses[0]), status: 'fail', undeclaredRemovals: [target],
    findings: [{rule: 'REMOVAL_DECLARATION_MISSING', severity: 'fail'}]};
  last.responses.unshift(failed);last.checkAttempts = 2;
  const result = removalWorkflow(combined, options);
  assert.equal(result.omissionDetected, true);assert.deepEqual(result.evidence.omissionCheckSequences, [8]);
  assert.equal(result.correctionVerified, false); // No separately observed declaration change after that feedback.
  assert.equal(result.checkTraceComplete, true);
  delete failed.findings;
  assert.equal(removalWorkflow(combined, options).checkTraceComplete, false);
});

test('the parent observer captures actual missing-removal findings and the final saved decision', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-removal-observer-'));
  t.after(() => {
    const resolved = fs.realpathSync(parent);assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('terse-removal-observer-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const project = createWorkspace(parent, 'project');fs.writeFileSync(path.join(project, 'src/old.ts'), 'export function old() {return 1;}');
  invoke(project, ['init']);const begun = invoke(project, ['begin', '--task', 'Retire old', '--query', 'old']);
  const candidate = begun.context.candidates.find(item => item.path === 'src/old.ts');
  invoke(project, ['decide', '--run', begun.run, '--strategy', 'refactor', '--candidate', candidate.candidateId, '--rationale', 'Retire the old implementation.']);
  fs.unlinkSync(path.join(project, 'src/old.ts'));
  const report = invoke(project, ['check', '--run', begun.run, '--summary'], 1);
  const observer = skillObserver(project, {});
  observer.observe({type: 'item.completed', item: {id: 'check', type: 'command_execution', command: 'node cli.js check', aggregated_output: JSON.stringify(report)}});
  assert.deepEqual(observer.observations[0].responses[0].undeclaredRemovals, [{path: 'src/old.ts'}]);
  assert(observer.observations[0].responses[0].findings.some(item => item.rule === 'REMOVAL_DECLARATION_MISSING'));
  assert.deepEqual(captureRunStates(project)[0].remove, []);
});
