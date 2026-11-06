import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {createHash} from 'node:crypto';

export const inScope = (file, editable) => editable.some(entry => entry.endsWith('/') ? file.startsWith(entry) : file === entry);

export function verifyCommand(project, label, args, directory, {env = process.env, expectedCounts, expectedTests, timeoutMs = 120_000} = {}) {
  const start = performance.now();
  const result = spawnSync(process.execPath, args, {cwd: project, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024});
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  fs.writeFileSync(path.join(directory, `${label}.log`), log);
  const counts = expectedCounts ? upstreamCounts(log) : undefined;
  const testCounts = expectedTests === undefined ? undefined : Object.fromEntries(['tests', 'pass', 'fail', 'cancelled'].map(name => [name,
    Number(new RegExp(`(?:^|\\n)[^\\n]*?\\b${name} (\\d+)\\b`).exec(log)?.[1] ?? NaN)]));
  return {exitCode: result.status, error: result.error?.message ?? null,
    passed: result.status === 0 && !result.error && !result.signal && (!counts || JSON.stringify(counts) === JSON.stringify(expectedCounts))
      && (!testCounts || testCounts.tests === expectedTests && testCounts.pass === expectedTests && testCounts.fail === 0 && testCounts.cancelled === 0),
    elapsedMs: Math.round(performance.now() - start), logHash: createHash('sha256').update(log).digest('hex'), ...(counts ? {counts} : {}), ...(testCounts ? {testCounts} : {})};
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

export function collectChanges(root, editable) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'});
  const lines = text => text.trim().split(/\r?\n/).filter(Boolean);
  const changed = lines(git('diff', '--name-only'));
  const untracked = lines(git('ls-files', '--others', '--exclude-standard'));
  const permitted = file => inScope(file, editable);
  const added = untracked.filter(permitted);
  // Capture accepted newly created helpers too; ordinary git diff omits untracked files.
  if (added.length) git('add', '--intent-to-add', '--', ...added);
  return { changed: [...changed, ...added].sort(),
    outsideScope: [...changed, ...untracked].filter(file => !permitted(file)),
    patch: git('diff', '--binary') };
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
