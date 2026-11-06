import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {snapshot, loadRun, readJson} from '../../dist/project.js';
import {validateDecision} from '../../dist/decision.js';
import {jsonObjects, checkInvocationCount} from './agent-events.mjs';
import assert from 'node:assert/strict';
import {inScope} from './benchmark-project.mjs';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
export const list = (root, directory = '') => fs.readdirSync(path.join(root, directory), {withFileTypes: true}).flatMap(entry => {
  const relative = path.posix.join(directory, entry.name);
  return ['.git', '.terse', 'node_modules'].includes(entry.name) ? [] : entry.isDirectory() ? list(root, relative) : [relative];
}).sort();
export const hashFiles = (root, files) => Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
const normal = text => text.replaceAll('\r\n', '\n').trim();

export function scopeHash(project, editable) {
  return hash(JSON.stringify(list(project).filter(file => inScope(file, editable)).map(file => [file,
    fs.lstatSync(path.join(project, file)).isFile() ? hash(fs.readFileSync(path.join(project, file))) : 'non-regular'])));
}

export function skillObserver(project, protectedHashes, {editable = ['src/']} = {}) {
  const observations = [];
  const skill = normal(fs.readFileSync(path.join(project, '.agents/skills/terse/SKILL.md'), 'utf8'));
  return {observations, observe(event) {
    const item = event.item;
    if (!['item.started', 'item.completed'].includes(event.type) || !['command_execution', 'file_change'].includes(item?.type)) return;
    const state = snapshot(project);
    const runs = path.join(project, '.terse/runs');
    const runStates = fs.existsSync(runs) ? fs.readdirSync(runs).map(run => {
      try {
        const {baseline, dir} = loadRun(project, run);
        const {decision} = validateDecision(readJson(path.join(dir, 'decision.json')));
        const history = fs.existsSync(path.join(dir, 'context.json')) ? readJson(path.join(dir, 'context.json')) : [];
        return {run, baselineHash: baseline.snapshot.hash,
          retrieved: Array.isArray(history) && history.some(item => item.snapshotHash === baseline.snapshot.hash && Array.isArray(item.errors) && !item.errors.length),
          decided: !!decision, decisionHash: decision ? hash(JSON.stringify(decision)) : null,
          strategy: decision?.strategy ?? null, remove: decision?.remove ?? []};
      } catch { return {run, invalid: true}; }
    }) : [];
    const commandOutput = event.type === 'item.completed' && item.type === 'command_execution' ? item.aggregated_output ?? '' : '';
    const responses = jsonObjects(commandOutput).filter(value => value.schemaVersion === 1 && ['begin', 'context', 'decide', 'check'].includes(value.command))
      .map(value => ({command: value.command, run: value.run ?? null, status: value.status, outputKind: value.outputKind, exitCode: value.exitCode,
        baselineHash: value.baselineHash ?? null, snapshotHash: value.snapshotHash ?? null,
        verification: (value.verification ?? []).map(item => ({status: item.status, command: item.command})),
        errors: value.errors?.length ?? 0}));
    const tampered = Object.entries(protectedHashes).filter(([file, expected]) => {
      try { return !fs.lstatSync(path.join(project, file)).isFile() || hash(fs.readFileSync(path.join(project, file))) !== expected; }
      catch { return true; }
    }).map(([file]) => file);
    const sourceEdits = (item.changes ?? []).map(change => ({path: path.relative(project, path.resolve(project, change.path)).replaceAll('\\', '/'), kind: change.kind}));
    observations.push({sequence: observations.length, event: event.type, itemId: item.id, itemType: item.type,
      sourceHash: state.hash, scopeHash: scopeHash(project, editable), runStates, responses, tampered, sourceEdits,
      checkAttempts: event.type === 'item.completed' ? Math.max(checkInvocationCount(item.command ?? ''), responses.filter(item => item.command === 'check').length) : 0,
      skillRead: normal(commandOutput).includes(skill),
      ...(item.command ? {commandHash: hash(item.command)} : {})});
  }};
}

// This grades observed ordering conservatively. Same-command writes may not
// expose an unchanged checkpoint; absence of that evidence is not success.
export function skillWorkflow(observations, {initialHash, finalHash, verification, removals = [], traceComplete, editable = ['src/'], initialScopeHash, finalScopeHash}) {
  const runIds = [...new Set(observations.flatMap(item => item.runStates.map(run => run.run)))];
  const singleRun = runIds.length === 1, run = singleRun ? runIds[0] : null;
  const firstEdit = observations.find(item => item.sourceHash !== initialHash
    || initialScopeHash && item.scopeHash !== initialScopeHash || item.sourceEdits.some(edit => inScope(edit.path, editable)));
  const beforeEdit = observations.filter(item => !firstEdit || item.sequence < firstEdit.sequence);
  const validRun = state => state.run === run && !state.invalid && state.baselineHash === initialHash;
  const beginning = beforeEdit.find(item => item.responses.some(response => response.command === 'begin' && response.outputKind === 'result'
    && response.exitCode === 0 && response.run === run && response.snapshotHash === initialHash));
  const retrieval = beforeEdit.find(item => item.sourceHash === initialHash && item.runStates.some(state => validRun(state) && state.retrieved));
  const decision = beforeEdit.find(item => item.sourceHash === initialHash && item.runStates.some(state => validRun(state) && state.retrieved && state.decided
    && removals.every(removal => state.remove.some(actual => actual.path === removal.path && actual.symbol === removal.symbol))));
  const lastCheck = observations.flatMap(item => {
    const responses = item.responses.filter(response => response.command === 'check');
    const attempts = Math.max(item.checkAttempts ?? 0, responses.length);
    // Missing responses make a multi-call command ambiguous. A later separately
    // observed full check can recover; an old pass cannot hide this attempt.
    if (!attempts) return [];
    const start = observations.findLast(candidate => candidate.sequence < item.sequence && candidate.itemId === item.itemId
      && candidate.event === 'item.started' && candidate.itemType === 'command_execution');
    // A completed command may contain edits after check. Bind new scoped traces
    // to the entire observed command interval, withholding credit if ambiguous.
    // Legacy cohorts have no scope checkpoints and keep their original grading.
    const scopeStable = finalScopeHash === undefined || !!start && typeof item.scopeHash === 'string'
      && observations.filter(candidate => candidate.sequence >= start.sequence && candidate.sequence <= item.sequence)
        .every(candidate => candidate.scopeHash === item.scopeHash);
    return [{sequence: item.sequence, scopeHash: item.scopeHash, scopeStable, response: attempts > responses.length ? null : responses.at(-1)}];
  }).at(-1);
  const fullFinalCheck = !!lastCheck?.response && lastCheck.scopeStable && lastCheck.response.outputKind === 'result' && lastCheck.response.run === run
    && lastCheck.response.baselineHash === initialHash && lastCheck.response.snapshotHash === finalHash
    && (finalScopeHash === undefined || lastCheck.scopeHash === finalScopeHash)
    && verification.length > 0 && JSON.stringify(lastCheck.response.verification.map(item => item.command)) === JSON.stringify(verification)
    && lastCheck.response.verification.every(item => ['passed', 'failed', 'error'].includes(item.status));
  const stages = {skillReadObserved: beforeEdit.some(item => item.skillRead), singleRun,
    beginBeforeEdit: !!beginning, retrievalBeforeEdit: !!retrieval, decisionBeforeEdit: !!decision,
    sourceChanged: !!firstEdit && finalHash !== initialHash, fullFinalCheck,
    checkPassed: fullFinalCheck && lastCheck.response.status === 'pass' && lastCheck.response.errors === 0
      && lastCheck.response.verification.every(item => item.status === 'passed')};
  return {...stages, completed: traceComplete && Object.values(stages).every(Boolean) && observations.every(item => !item.tampered.length),
    evidence: {run, firstEditSequence: firstEdit?.sequence ?? null, beginSequence: beginning?.sequence ?? null,
      retrievalSequence: retrieval?.sequence ?? null, decisionSequence: decision?.sequence ?? null, finalCheckSequence: lastCheck?.sequence ?? null}};
}

export function skillSummary(results, reviews) {
  assert.equal(reviews.length, results.length, 'Every session, including failures, needs a patch review');
  assert.equal(new Set(reviews.map(item => item.artifactId)).size, reviews.length);
  for (const result of results) {
    const review = reviews.find(item => item.artifactId === result.artifactId);
    assert(review && review.patchHash === result.evidence.patchHash, 'Review must bind the actual patch');
    assert.equal(typeof review.duplicateFree, 'boolean');assert.equal(typeof review.cleanupComplete, 'boolean');
    assert(typeof review.reason === 'string' && review.reason.trim(), 'Review needs source-specific reasons');
  }
  const count = predicate => results.filter(predicate).length;
  const reviewed = result => reviews.find(item => item.artifactId === result.artifactId);
  return {sessions: results.length, protocolValid: count(item => item.protocolValid), behaviorCorrect: count(item => item.correct),
    skillReadObserved: count(item => item.workflow.skillReadObserved), beginBeforeEdit: count(item => item.workflow.beginBeforeEdit),
    retrievalBeforeEdit: count(item => item.workflow.retrievalBeforeEdit), decisionBeforeEdit: count(item => item.workflow.decisionBeforeEdit),
    fullFinalCheck: count(item => item.workflow.fullFinalCheck), workflowCompleted: count(item => item.workflow.completed),
    duplicateFree: count(item => reviewed(item).duplicateFree), cleanupComplete: count(item => reviewed(item).cleanupComplete),
    functional: count(item => item.protocolValid && item.correct && reviewed(item).duplicateFree && reviewed(item).cleanupComplete),
    workflowAndFunctional: count(item => item.protocolValid && item.correct && item.workflow.completed && reviewed(item).duplicateFree && reviewed(item).cleanupComplete)};
}
