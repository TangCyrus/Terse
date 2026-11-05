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
  const added = untracked.filter(file => editable.includes(file));
  // Capture accepted newly created helpers too; ordinary git diff omits untracked files.
  if (added.length) git('add', '--intent-to-add', '--', ...added);
  return { changed: [...changed, ...added].sort(),
    outsideScope: [...changed, ...untracked].filter(file => !editable.includes(file)),
    patch: git('diff', '--binary') };
}

export function upstreamCounts(output) {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  return { passed: Number(/(\d+) tests? passed/.exec(plain)?.[1] ?? 0),
    knownFailures: Number(/(\d+) known failures?/.exec(plain)?.[1] ?? 0) };
}
