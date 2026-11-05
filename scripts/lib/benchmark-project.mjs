import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  const permitted = file => editable.some(entry => entry.endsWith('/') ? file.startsWith(entry) : file === entry);
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
  }
  return Object.fromEntries(['control', 'terse'].map(arm => {
    const runs = results.filter(result => result.arm === arm);
    return [arm, {runs: runs.length, behaviorCorrect: runs.filter(result => result.correct).length,
      functional: runs.filter(result => reviews.find(review => review.artifactId === result.artifactId).functional).length}];
  }));
}
