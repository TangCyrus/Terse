import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {rootOf, snapshot} from '../../dist/project.js';
import {indexSources} from '../../dist/analyze.js';
import {showConfiguration, verifyConfiguration, captureChangeBaseline, collectChanges} from './benchmark-project.mjs';
import {freezeTestCases} from './test-evidence.mjs';

// Shared by explicit-prompt comparisons and installed-Skill sessions. Setup is
// completed before either workflow begins; no task baseline is created here.
export function prepareOpenSourceProject({source, directory, files, dependencyLock, flattened, originalConfiguration, task, specification, commands, setup}) {
  const project = path.join(directory, 'project');fs.mkdirSync(project, {recursive: true});
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(project, file)), {recursive: true});
    fs.copyFileSync(path.join(source, file), path.join(project, file));
  }
  fs.writeFileSync(path.join(project, 'package-lock.json'), dependencyLock);
  fs.cpSync(path.join(source, 'node_modules'), path.join(project, 'node_modules'), {recursive: true});
  if (flattened) {
    fs.writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify(flattened, null, 2) + '\n');
    verifyConfiguration(originalConfiguration, showConfiguration(project), source, project);
  }
  setup?.(project);
  fs.appendFileSync(path.join(project, '.gitignore'), '\n.terse/\n');
  execFileSync('git', ['init', '-q'], {cwd: project});
  const config = {exclude: specification.exclude ?? ['test.js', 'index.test-d.ts'], minTokens: 50, minLines: 5, duplicatePolicy: 'review',
    verification: Object.values(commands).map(args => ({command: 'node', args, timeoutMs: 120_000}))};
  fs.writeFileSync(path.join(project, 'terse.config.json'), JSON.stringify(config, null, 2) + '\n');
  execFileSync('git', ['add', '.'], {cwd: project, stdio: 'pipe'});
  const root = rootOf(project), before = snapshot(root);
  const changeBaseline = captureChangeBaseline(root);
  const acceptanceCases = commands.acceptance ? freezeTestCases(root, commands.acceptance) : undefined;
  assert.deepEqual(indexSources(before, root).errors, [], 'Prepared project must be analyzable before starting agents');
  assert.deepEqual(collectChanges(root, task.editable, changeBaseline), {changed: [], outsideScope: [], patch: ''});
  return {root, project: root, commands, config, before, changeBaseline, acceptanceCases};
}
