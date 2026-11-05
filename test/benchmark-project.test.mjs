import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {flattenConfiguration, verifyConfiguration, collectChanges, upstreamCounts, validateFunctionalReviews} from '../scripts/lib/benchmark-project.mjs';

function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-benchmark-'));
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-benchmark-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  return parent;
}

test('benchmark preparation retains strict compiler options and dynamic inclusion', () => {
  const original = {compilerOptions: {strict: true, noEmitOnError: true, noUncheckedIndexedAccess: true},
    files: ['./source/old.ts'], include: ['source'], exclude: [path.resolve('upstream/dist')]};
  const flattened = flattenConfiguration(original, path.resolve('upstream'));
  assert.deepEqual(flattened, {compilerOptions: original.compilerOptions, include: ['source'], exclude: ['dist']});
  assert(!Object.hasOwn(flattened, 'files'));
  verifyConfiguration(original, {...original});
  for (const invalid of [{...original, compilerOptions: {strict: false}}, {...original, files: []}, {...original, include: ['source/index.ts']}]) {
    assert.throws(() => verifyConfiguration(original, invalid));
  }
  const copied = {...original, exclude: [path.resolve('copy/dist')]};
  verifyConfiguration(original, copied, path.resolve('upstream'), path.resolve('copy'));
  assert.throws(() => verifyConfiguration(original, {...copied, exclude: ['source']}, path.resolve('upstream'), path.resolve('copy')));
});

test('benchmark patches include new helpers and deleted modules while flagging out-of-scope edits', t => {
  const parent = workspace(t);
  const git = (...args) => execFileSync('git', args, {cwd: parent, stdio: 'pipe'});
  git('init', '-q');
  fs.writeFileSync(path.join(parent, 'old.ts'), 'export const old = 1;\n');
  git('add', '.');
  fs.unlinkSync(path.join(parent, 'old.ts'));
  const helper = 'export const helper = () => 1;\n';
  fs.writeFileSync(path.join(parent, 'helper.ts'), helper);
  fs.writeFileSync(path.join(parent, 'unexpected.ts'), 'outside scope\n');
  const result = collectChanges(parent, ['old.ts', 'helper.ts']);
  assert.deepEqual(result.changed, ['helper.ts', 'old.ts']);
  assert.deepEqual(result.outsideScope, ['unexpected.ts']);
  assert.match(result.patch, /new file mode/);
  assert.match(result.patch, /deleted file mode/);
  assert.match(result.patch, /export const helper/);
  assert.equal(fs.readFileSync(path.join(parent, 'helper.ts'), 'utf8'), helper);
});

test('upstream counts distinguish expected failures from passing tests', () => {
  assert.deepEqual(upstreamCounts('\u001b[32m45 tests passed\u001b[0m\n2 known failures'), {passed: 45, knownFailures: 2});
  assert.deepEqual(upstreamCounts('1 test passed\n1 known failure'), {passed: 1, knownFailures: 1});
  assert.deepEqual(upstreamCounts('initialization failed'), {passed: 0, knownFailures: 0});
});

test('functional grading requires patch review and cannot promote zero-clone or incomplete runs', () => {
  const results = [
    {artifactId: 'modify-control', arm: 'control', correct: true, protocolValid: true, newDuplications: 0, evidence: {patchHash: 'copied-semantics'}},
    {artifactId: 'modify-terse', arm: 'terse', correct: true, protocolValid: true, newDuplications: 0, evidence: {patchHash: 'reused-owner'}},
  ];
  const reviews = [
    {artifactId: 'modify-control', patchHash: 'copied-semantics', functional: false, reason: 'Behavior passed, but the route implements another CSV encoder with different tokens.'},
    {artifactId: 'modify-terse', patchHash: 'reused-owner', functional: true, reason: 'Route delegates to the existing exporter; one encoder remains.'},
  ];
  assert.deepEqual(validateFunctionalReviews(results, reviews), {
    control: {runs: 1, behaviorCorrect: 1, functional: 0}, terse: {runs: 1, behaviorCorrect: 1, functional: 1},
  });
  assert.throws(() => validateFunctionalReviews(results, []), /Every run/);
  assert.throws(() => validateFunctionalReviews(results, [reviews[0], reviews[0]]), /unique/);
  assert.throws(() => validateFunctionalReviews(results, [reviews[0], {...reviews[1], patchHash: 'other'}]), /exact observed/);
  assert.throws(() => validateFunctionalReviews([{...results[1], protocolValid: false}], [reviews[1]]), /Incomplete/);
  assert.throws(() => validateFunctionalReviews([{...results[1], correct: false}], [reviews[1]]), /behavior-incorrect/);
});

test('agent publication uses task-specific artifacts and preserves unknown duplicate measurements', t => {
  const parent = workspace(t);
  const label = 'refactor-pair-1-terse';
  fs.mkdirSync(path.join(parent, label));
  fs.writeFileSync(path.join(parent, label, 'implementation.patch'), 'new helper patch\n');
  fs.writeFileSync(path.join(parent, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(parent, 'comparison.json'), JSON.stringify({schemaVersion: 2, kind: 'open-source-agent-comparison',
    artifactDirectory: parent, results: [{artifactId: label, taskId: 'refactor', repetition: 1, arm: 'terse',
      newDuplications: null, duplicationError: 'Analysis failed', protocolValid: false,
      events: {errors: ['Reconnecting with a machine-specific detail'], finalMessage: 'Private prose'}}]}));
  const target = path.join(parent, 'publication');
  const script = fileURLToPath(new URL('../scripts/export-agent-benchmark.mjs', import.meta.url));
  execFileSync(process.execPath, [script, '--input', parent, '--output', target], {stdio: 'pipe'});
  const report = JSON.parse(fs.readFileSync(path.join(target, 'comparison.json'), 'utf8'));
  assert.equal(report.results[0].patch, `${label}.patch`);
  assert.equal(fs.readFileSync(path.join(target, `${label}.patch`), 'utf8'), 'new helper patch\n');
  assert.equal(report.results[0].newDuplications, null);
  assert.equal(report.results[0].duplications, null);
  assert.equal(report.results[0].protocolValid, false);
  assert(!Object.hasOwn(report.results[0].events, 'finalMessage'));
  assert.deepEqual(report.results[0].events.errors, ['Transport reconnect']);
  assert(!Object.hasOwn(report, 'artifactDirectory'));
  assert.throws(() => execFileSync(process.execPath, [script, '--input', parent, '--output', target], {stdio: 'pipe'}));
});

test('retrospective decision measurements refuse altered raw events and never overwrite observations', t => {
  const parent = workspace(t);
  const label = 'pair-1-terse';
  fs.mkdirSync(path.join(parent, label));
  const raw = JSON.stringify({type: 'turn.completed'}) + '\n';
  fs.writeFileSync(path.join(parent, label, 'agent.jsonl'), raw);
  const report = {kind: 'open-source-agent-comparison', results: [{repetition: 1, arm: 'terse', evidence: {
    eventHash: createHash('sha256').update(raw).digest('hex')}, events: {commandCount: 0}}]};
  const reportPath = path.join(parent, 'comparison.json');
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const output = path.join(parent, 'measured.json');
  const script = fileURLToPath(new URL('../scripts/measure-agent-decisions.mjs', import.meta.url));
  const args = [script, '--report', reportPath, '--events', parent, '--output', output];
  execFileSync(process.execPath, args, {stdio: 'pipe'});
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).results[0].decisions.retries, 0);
  assert.throws(() => execFileSync(process.execPath, args, {stdio: 'pipe'}));
  fs.appendFileSync(path.join(parent, label, 'agent.jsonl'), '{}\n');
  assert.throws(() => execFileSync(process.execPath, [...args.slice(0, -1), path.join(parent, 'altered.json')], {stdio: 'pipe'}));
  assert(!fs.existsSync(path.join(parent, 'altered.json')));
  assert.equal(fs.readFileSync(reportPath, 'utf8'), JSON.stringify(report));
});
