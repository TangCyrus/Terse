import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {removalWorkflow, removalSummary} from '../scripts/lib/skill-evidence.mjs';
import {verifyPqueueSkillPublication} from './support/pqueue-skill-publication.mjs';

test('p-queue removal retest preserves ordinary prompts, all sessions and declaration repair evidence', async t => {
  const {report, reviews, directory} = await verifyPqueueSkillPublication(t, 'p-queue-removal-observed');
  assert.equal(report.removalTracking, 'removal-declarations/1');
  const historical = JSON.parse(fs.readFileSync(new URL('../benchmarks/skill/p-queue-observed/report.json', import.meta.url), 'utf8'));
  assert.equal(report.upstream.commit, historical.upstream.commit);
  assert.equal(report.upstream.dependencyLockHash, historical.upstream.dependencyLockHash);
  for (const task of report.tasks) assert.equal(task.promptHash, historical.tasks.find(item => item.id === task.id).promptHash);
  for (const result of report.results) {
    const observations = JSON.parse(fs.readFileSync(path.join(directory, result.observations), 'utf8'));
    const task = report.tasks.find(item => item.id === result.taskId);
    assert(Array.isArray(result.finalRunStates));
    assert.deepEqual(result.removalWorkflow, removalWorkflow(observations, {initialHash: result.baselineHash, finalHash: result.snapshotHash,
      initialScopeHash: result.initialScopeHash, finalScopeHash: result.finalScopeHash, editable: result.editable,
      verification: result.verification, removals: task.remove, finalRunStates: result.finalRunStates,
      traceComplete: result.events.completed && !result.observationErrors.length}));
    const review = reviews.find(item => item.artifactId === result.artifactId);
    assert.equal(review.eventHash, result.evidence.eventHash);
    assert.equal(typeof review.remainingReviewDisclosed, 'boolean');
    if (result.removalWorkflow.correctionVerified) assert.equal(result.removalWorkflow.omissionDetected, true);
    if (result.taskId === 'modify') assert.equal(result.removalWorkflow.proactiveDeclaration, false);
    if (result.removalWorkflow.finalCheckStatus === 'needs-review') assert.equal(result.workflow.checkPassed, false);
  }
  assert.deepEqual(report.removalSummary, removalSummary(report.results));
  assert.equal(report.removalSummary.applicable, 4);
  assert(report.removalSummary.proactiveDeclarations <= 4);
  assert(report.removalSummary.correctionsVerified <= report.removalSummary.omissionsDetected);
});
