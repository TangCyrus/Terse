import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('project evaluation compares paired behavior and keeps legitimate additions and uncertainty visible', t => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/evaluate.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const summary = JSON.parse(run.stdout);
  const stored = JSON.parse(fs.readFileSync(summary.report, 'utf8'));
  assert.deepEqual(stored.results, summary.results);
  assert.equal(summary.scenarios, 6);
  assert.equal(summary.variants, 11);
  assert.equal(summary.tokenUsage, null);
  const result = (scenario, variant) => summary.results.find(r => r.scenario === scenario && r.variant === variant);
  for (const scenario of ['modify', 'refactor']) {
    const copy = result(scenario, 'copy');
    const reuse = result(scenario, 'reuse');
    assert.equal(copy.baselineHash, reuse.baselineHash);
    assert.equal(copy.acceptanceHash, reuse.acceptanceHash);
    assert.equal(copy.behavior, 'passed');
    assert.equal(reuse.behavior, 'passed');
    assert(copy.newDuplications > reuse.newDuplications);
    assert.equal(reuse.newDuplications, 0);
  }
  const rewritten = result('modify', 'rewritten-copy');
  assert.equal(rewritten.behavior, 'passed');
  assert.equal(rewritten.status, 'pass');
  assert.equal(rewritten.newDuplications, 0);
  assert.equal(rewritten.authoredReview.functional, false);
  assert.equal(result('delete', 'retained').behavior, 'passed');
  assert.equal(result('delete', 'retained').status, 'fail');
  assert.equal(result('delete', 'dangling').behavior, 'failed');
  const cleanup = result('delete', 'cleanup');
  assert.equal(cleanup.status, 'pass');
  assert(!fs.existsSync(path.join(cleanup.project, 'src/legacy.ts')));
  assert.equal(result('add', 'new').status, 'pass');
  assert.deepEqual(result('add', 'new').candidates, []);
  assert.equal(result('independent', 'review').behavior, 'passed');
  assert.equal(result('independent', 'review').status, 'needs-review');
  assert(result('dynamic', 'review').rules.includes('REMOVAL_REFERENCE_UNRESOLVED'));
  for (const r of summary.results) t.diagnostic(JSON.stringify({ scenario: r.scenario, variant: r.variant,
    behavior: r.behavior, status: r.status, duplicateGroups: r.newDuplications, rules: r.rules, timingsMs: r.timingsMs }));
});
