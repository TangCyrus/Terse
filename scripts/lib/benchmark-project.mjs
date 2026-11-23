import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import {createHash} from 'node:crypto';
import {testArguments, testEvidence} from './test-evidence.mjs';

export const inScope = (file, editable) => editable.some(entry => entry.endsWith('/') ? file.startsWith(entry) : file === entry);

export function verifyCommand(project, label, args, directory, {env = process.env, expectedCounts, expectedCases, timeoutMs = 120_000} = {}) {
  const start = performance.now();
  const result = spawnSync(process.execPath, testArguments(args, expectedCases), {cwd: project, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024});
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  fs.writeFileSync(path.join(directory, `${label}.log`), log);
  const counts = expectedCounts ? upstreamCounts(log) : undefined;
  const evidence = expectedCases ? testEvidence(result.stdout ?? '', expectedCases) : undefined;
  return {exitCode: result.status, error: result.error?.message ?? null,
    passed: result.status === 0 && !result.error && !result.signal && (!counts || JSON.stringify(counts) === JSON.stringify(expectedCounts))
      && (!evidence || evidence.passed),
    elapsedMs: Math.round(performance.now() - start), logHash: createHash('sha256').update(log).digest('hex'), ...(counts ? {counts} : {}), ...(evidence ? {testEvidence: evidence} : {})};
}

export function showConfiguration(root) {
  return JSON.parse(execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--showConfig'], {cwd: root, encoding: 'utf8'}));
}

export function flattenConfiguration(configuration, originalRoot) {
  // Keep include dynamic so deleting/adding a task's source file does not pin the old file list.
  return { compilerOptions: configuration.compilerOptions, include: configuration.include,
    exclude: configuration.exclude?.map(file => path.isAbsolute(file) ? path.relative(originalRoot, file).replaceAll('\\', '/') : file) };
}

export function verifyConfiguration(expected, actual, expectedRoot, actualRoot) {
  assert.deepEqual(actual.compilerOptions, expected.compilerOptions, 'Flattening must preserve all effective compiler options');
  assert.deepEqual(actual.files, expected.files, 'Flattening must preserve baseline source coverage');
  assert.deepEqual(actual.include, expected.include, 'Flattening must preserve dynamic source inclusion');
  if (expectedRoot && actualRoot) assert.deepEqual(flattenConfiguration(actual, actualRoot).exclude,
    flattenConfiguration(expected, expectedRoot).exclude, 'Flattening must preserve source exclusions');
}

const gitAt = (root, args, options = {}) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, ...options});
const paths = output => output.split('\0').filter(Boolean);

// Snapshot the actual files using a private index: neither HEAD nor the mutable
// agent index is a task baseline. This also supports repositories without commits.
function workingTree(root, baseline) {
  const tracked = paths(gitAt(root, ['ls-files', '--cached', '-z']));
  const original = baseline ? paths(gitAt(root, ['ls-tree', '-r', '--name-only', '-z', baseline])) : [];
  const untracked = paths(gitAt(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const originalPaths = new Set(original);
  const files = [...new Set([...original, ...tracked, ...untracked])].filter(file => originalPaths.has(file) || fs.existsSync(path.join(root, file)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-patch-index-'));
  const env = {...process.env, GIT_INDEX_FILE: path.join(directory, 'index'), GIT_LITERAL_PATHSPECS: '1'};
  try {
    gitAt(root, baseline ? ['read-tree', baseline] : ['read-tree', '--empty'], {env});
    if (files.length) gitAt(root, ['add', '--all', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], {env, input: files.join('\0') + '\0'});
    return gitAt(root, ['write-tree'], {env}).trim();
  } finally {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-patch-index-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  }
}

export function captureChangeBaseline(root) {
  return workingTree(root);
}

export function collectChanges(root, editable, baseline) {
  assert(typeof baseline === 'string' && /^[a-f0-9]{40,64}$/.test(baseline), 'A frozen task baseline is required');
  const current = workingTree(root, baseline);
  const diff = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', baseline, current];
  const changed = paths(gitAt(root, [...diff, '--name-only', '-z'])).sort();
  return {changed, outsideScope: changed.filter(file => !inScope(file, editable)), patch: gitAt(root, [...diff, '--binary'])};
}

export function upstreamCounts(output) {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  return { passed: Number(/(\d+) tests? passed/.exec(plain)?.[1] ?? 0),
    knownFailures: Number(/(\d+) known failures?/.exec(plain)?.[1] ?? 0) };
}

export function protectedFileEvidence(root, expected, acceptanceFiles) {
  const acceptance = Object.fromEntries(acceptanceFiles.map(file => {
    assert(typeof expected[file] === 'string', `Missing baseline acceptance hash: ${file}`);
    return [file, expected[file]];
  }));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const tampered = Object.entries(expected).filter(([file, digest]) => {
    try { return !fs.lstatSync(path.join(root, file)).isFile() || hash(fs.readFileSync(path.join(root, file))) !== digest; }
    catch { return true; }
  }).map(([file]) => file);
  return {tampered, acceptanceHash: hash(JSON.stringify(acceptance))};
}

// A zero token-clone count or green runtime tests cannot stand in for implementation review.
export function validateFunctionalReviews(results, reviews) {
  assert.equal(reviews.length, results.length, 'Every run, including failures, needs a review');
  assert.equal(new Set(reviews.map(review => review.artifactId)).size, results.length, 'Reviews must be unique');
  for (const result of results) {
    const review = reviews.find(item => item.artifactId === result.artifactId);
    assert(review, `Missing review: ${result.artifactId}`);
    assert.equal(review.patchHash, result.evidence.patchHash, 'Review must refer to the exact observed implementation');
    assert.equal(typeof review.functional, 'boolean');
    assert(typeof review.reason === 'string' && review.reason.trim(), 'Review needs a concrete rationale');
    if (review.functional) assert(result.correct && result.protocolValid, 'Incomplete or behavior-incorrect runs cannot count as functional successes');
    if (result.draft) {
      assert.equal(review.draftReview?.patchHash,result.evidence.draftPatchHash,'Draft review must bind the original candidate');
      for (const item of [review.draftReview,review.finalReview]) {
        assert(item && typeof item.duplicateFree==='boolean' && typeof item.cleanupComplete==='boolean');
        assert(typeof item.reason==='string' && item.reason.trim());
      }
      assert.equal(typeof review.draftReview.functional,'boolean');
      if (review.draftReview.functional) assert(result.draft.acceptance.passed && result.draft.protocolValid
        && review.draftReview.duplicateFree && review.draftReview.cleanupComplete,'Incomplete or redundant drafts cannot count as functional successes');
      if (review.functional) assert(review.finalReview.duplicateFree && review.finalReview.cleanupComplete,'Final success requires reviewed reuse and cleanup');
    }
  }
  return Object.fromEntries(['control', 'terse'].map(arm => {
    const runs = results.filter(result => result.arm === arm);
    return [arm, {runs: runs.length, behaviorCorrect: runs.filter(result => result.correct).length,
      functional: runs.filter(result => reviews.find(review => review.artifactId === result.artifactId).functional).length,
      ...(runs.length && runs.every(result=>result.draft) ? {
        draftBehaviorCorrect:runs.filter(result=>result.draft.acceptance.passed && !result.draft.tampered?.length).length,
        draftFunctional:runs.filter(result=>reviews.find(review=>review.artifactId===result.artifactId).draftReview.functional).length,
        draftDuplicateFree:runs.filter(result=>reviews.find(review=>review.artifactId===result.artifactId).draftReview.duplicateFree).length,
        finalDuplicateFree:runs.filter(result=>reviews.find(review=>review.artifactId===result.artifactId).finalReview.duplicateFree).length,
        draftCleanupComplete:runs.filter(result=>reviews.find(review=>review.artifactId===result.artifactId).draftReview.cleanupComplete).length,
        finalCleanupComplete:runs.filter(result=>reviews.find(review=>review.artifactId===result.artifactId).finalReview.cleanupComplete).length,
      } : {})}];
  }));
}
