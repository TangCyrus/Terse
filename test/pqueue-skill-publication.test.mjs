import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {skillWorkflow} from '../scripts/lib/skill-evidence.mjs';
import {verifyPqueueSkillPublication} from './support/pqueue-skill-publication.mjs';

test('scoped check credit requires an unchanged start-to-completion interval', () => {
  const directory = fileURLToPath(new URL('../benchmarks/skill/p-queue-observed/', import.meta.url));
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
  const result = report.results.find(item => item.artifactId === 'modify-session-1');
  const original = JSON.parse(fs.readFileSync(path.join(directory, result.observations), 'utf8'));
  const options = {initialHash: result.baselineHash, finalHash: result.snapshotHash, verification: result.verification,
    initialScopeHash: result.initialScopeHash, finalScopeHash: result.finalScopeHash, editable: result.editable, traceComplete: true};
  const completed = original.findLast(item => item.responses.some(response => response.command === 'check'));
  const started = original.find(item => item.itemId === completed.itemId && item.event === 'item.started');
  assert.equal(skillWorkflow(original, options).completed, true);
  // check; edit README in the same command: its completion and final state
  // agree, but the state at command start was different and cannot be credited.
  const edited = structuredClone(original);
  for (const item of edited.filter(item => item.sequence >= completed.sequence)) item.scopeHash = 'after-docs';
  assert.equal(skillWorkflow(edited, {...options, finalScopeHash: 'after-docs'}).fullFinalCheck, false);
  assert.equal(skillWorkflow(original.filter(item => item !== started), options).fullFinalCheck, false);
  const wrongId = structuredClone(original);wrongId.find(item => item.sequence === started.sequence).itemId = 'unrelated';
  assert.equal(skillWorkflow(wrongId, options).fullFinalCheck, false);
  const intervening = structuredClone(original);
  intervening.splice(intervening.findIndex(item => item.sequence === completed.sequence), 0,
    {...structuredClone(started), sequence: started.sequence + 0.5, itemId: 'parallel-edit', scopeHash: 'temporary-docs'});
  assert.equal(skillWorkflow(intervening, options).fullFinalCheck, false);
  const recovered = structuredClone(edited);
  recovered.push({...structuredClone(started), sequence: original.at(-1).sequence + 1, itemId: 'recheck', scopeHash: 'after-docs'},
    {...structuredClone(completed), sequence: original.at(-1).sequence + 2, itemId: 'recheck', scopeHash: 'after-docs'});
  assert.equal(skillWorkflow(recovered, {...options, finalScopeHash: 'after-docs'}).completed, true);
});

test('p-queue Skill evidence preserves upstream, dependency lock, all sessions and offline source effects', async t => {
  await verifyPqueueSkillPublication(t, 'p-queue-observed');
});
