import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(repository, 'dist/cli.js');

export function createWorkspace(parent, name, fixtureRoot = repository) {
  const directory = path.join(parent, name);
  fs.cpSync(path.join(fixtureRoot, 'examples/orders'), directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.gitignore'), '.terse/\n');
  execFileSync('git', ['init', '-q'], { cwd: directory });
  // Match CLI root normalization, including Windows 8.3 TEMP paths.
  return fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8' }).trim());
}

export function invoke(cwd, args, expected = 0, entryPoint = cli) {
  const env = { ...process.env };
  // Nested Node test runners otherwise treat verification as an existing test child
  // and may execute only the first file instead of the entire acceptance suite.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [entryPoint, ...args, '--cwd', cwd, '--json'], { encoding: 'utf8', timeout: 60_000, env });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.exitCode, result.status);
  return output;
}
