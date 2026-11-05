import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { invoke, repository } from './lib/workspace.mjs';
import { prepareEvaluation } from './lib/evaluation-project.mjs';
import { cases } from './evaluation-cases.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
fs.mkdirSync(path.join(repository, '.terse'), { recursive: true });
const destination = fs.mkdtempSync(path.join(repository, '.terse', 'evaluation-'));
const results = [];
const sourceState = project => {
  const files = Object.fromEntries(fs.readdirSync(path.join(project, 'src')).sort().map(name => [name, fs.readFileSync(path.join(project, 'src', name), 'utf8')]));
  return { files: Object.keys(files).length, lines: Object.values(files).reduce((sum, text) => sum + text.trimEnd().split('\n').length, 0),
    hash: digest(JSON.stringify(files)) };
};

for (const scenario of cases) {
  let baselineHash, sourceHash, acceptanceHash;
  for (const variant of scenario.variants) {
    const started = performance.now();
    const {project, sources, config} = prepareEvaluation(destination, `${scenario.id}-${variant.id}`, scenario);
    const before = sourceState(project);
    sourceHash ??= before.hash;
    assert.equal(before.hash, sourceHash, 'Paired variants must have identical starting source');
    const timingsMs = {};
    const run = (phase, args, expected = 0) => {
      const now = performance.now();
      const output = invoke(project, args, expected);
      timingsMs[phase] = Math.round(performance.now() - now);
      return output;
    };
    const begin = run('begin', ['begin', '--task', scenario.task]);
    baselineHash ??= begin.snapshotHash;
    assert.equal(begin.snapshotHash, baselineHash, 'Paired variants must have identical baseline snapshots');
    const context = run('context', ['context', '--run', begin.run, '--query', scenario.query, '--limit', '20']);
    assert.deepEqual(context.errors, []);
    if (scenario.candidate) assert(context.candidates.some(c => c.path === scenario.candidate.path && c.symbol === scenario.candidate.symbol));
    else assert.equal(context.candidates.length, 0, 'The new responsibility must have no matching baseline candidate');
    fs.writeFileSync(begin.decisionPath, JSON.stringify({ strategy: variant.strategy, rationale: scenario.rationale,
      considered: scenario.candidate ? [{ ...scenario.candidate, disposition: variant.strategy === 'new' ? 'reject' : 'modify', reason: scenario.rationale }] : [],
      remove: scenario.remove ?? [],
    }, null, 2));
    // Variant editors can only change src files; acceptance was installed by shared preparation.
    const tests = () => Object.fromEntries(fs.readdirSync(path.join(project, 'test')).sort().map(name => [name, digest(fs.readFileSync(path.join(project, 'test', name)))]));
    const frozenTests = tests();
    const testHash = digest(JSON.stringify(frozenTests));
    acceptanceHash ??= testHash;
    assert.equal(testHash, acceptanceHash, 'Paired variants must use identical acceptance tests');
    variant.edit(sources);
    assert.deepEqual(tests(), frozenTests, 'Implementation edits must not weaken acceptance');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, 'terse.config.json'), 'utf8')), config);
    const expectedCode = { pass: 0, fail: 1, 'needs-review': 2 }[variant.expected.status];
    const report = run('check', ['check', '--run', begin.run], expectedCode);
    assert.equal(report.status, variant.expected.status);
    assert.deepEqual(report.errors, []);
    assert.equal(report.newDuplications > 0, variant.expected.duplicates);
    assert.equal(report.verification.length, 1);
    assert.equal(report.verification[0].status, variant.expected.verification);
    if (variant.expected.verification === 'passed') assert.match(report.verification[0].output, /tests 3\b/, 'All three acceptance files must run');
    for (const rule of variant.expected.rules) assert(report.findings.some(f => f.rule === rule), `${scenario.id}/${variant.id}: ${rule}`);
    const duplicates = report.findings.filter(f => f.rule === 'NEW_DUPLICATION');
    assert(duplicates.every(f => f.attribution.currentOccurrences > f.attribution.baselineOccurrences));
    const reportFile = path.join(project, '.terse/runs', begin.run, 'report.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(reportFile, 'utf8')).findings, report.findings);
    timingsMs.total = Math.round(performance.now() - started);
    results.push({ scenario: scenario.id, variant: variant.id, task: scenario.task, rationale: scenario.rationale,
      oracle: variant.expected, authoredReview: variant.review ?? null, project, run: begin.run, baselineHash, acceptanceHash: testHash,
      candidates: context.candidates.map(({ path, symbol }) => ({ path, symbol })),
      status: report.status, behavior: report.verification[0].status, rules: report.findings.map(f => f.rule),
      newDuplications: report.newDuplications, duplicates: duplicates.map(({ locations, attribution }) => ({ locations, attribution })),
      sourceBefore: before, sourceAfter: sourceState(project), timingsMs, report: reportFile });
  }
}

const comparisons = ['modify', 'refactor'].map(scenario => {
  const control = results.find(r => r.scenario === scenario && r.variant === 'copy');
  const reuse = results.find(r => r.scenario === scenario && r.variant === 'reuse');
  assert.equal(control.behavior, 'passed');
  assert.equal(reuse.behavior, 'passed');
  assert(control.newDuplications > 0 && reuse.newDuplications === 0);
  return { scenario, controlGroups: control.newDuplications, reuseGroups: reuse.newDuplications, sameAcceptance: control.acceptanceHash === reuse.acceptanceHash };
});
const summary = { schemaVersion: 1, kind: 'controlled-project-evaluation', createdAt: new Date().toISOString(),
  tool: JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).version,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  model: null, tokenUsage: null, tokenUsageReason: 'No model is called; these authored variants cannot measure agent token savings.',
  scenarios: cases.length, variants: results.length, comparisons, results,
  interpretation: 'Paired behavior-correct variants demonstrate detectable duplication and a reuse alternative. Independent responsibilities and dynamic references require review. These local fixtures do not estimate autonomous-agent improvement or general false-positive/negative rates.',
};
const report = path.join(destination, 'evaluation.json');
fs.writeFileSync(report, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ ...summary, report }, null, 2));
