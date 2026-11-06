import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createWorkspace, repository} from './workspace.mjs';
import {snapshot} from '../../dist/project.js';
import {clones, indexSources, newClones} from '../../dist/analyze.js';
import {cleanupFindings} from '../../dist/cleanup.js';

// Both authored variants and live agents receive the same project and acceptance files.
export function prepareEvaluation(parent, name, scenario) {
  const project = createWorkspace(parent, name);
  const sources = {
    read: name => fs.readFileSync(path.join(project, 'src', name), 'utf8'),
    write: (name, content) => fs.writeFileSync(path.join(project, 'src', name), content),
    remove: name => fs.unlinkSync(path.join(project, 'src', name)),
  };
  const fixtures = path.join(repository, 'examples/evaluation');
  sources.write('routes.ts', fs.readFileSync(path.join(fixtures, 'routes.ts'), 'utf8'));
  fs.copyFileSync(path.join(fixtures, 'routes.test.mjs'), path.join(project, 'test/routes.test.mjs'));
  scenario.setup?.(sources);
  fs.copyFileSync(path.join(fixtures, `${scenario.id}.test.mjs`), path.join(project, 'test/acceptance.test.mjs'));
  const config = {minTokens: 50, minLines: 5, duplicatePolicy: 'review', exclude: ['test'], verification: [
    {command: 'node', args: ['--test', 'test/orders.test.mjs', 'test/routes.test.mjs', 'test/acceptance.test.mjs'], timeoutMs: 30_000},
  ]};
  fs.writeFileSync(path.join(project, 'terse.config.json'), JSON.stringify(config));
  return {project, sources, config};
}

// Grading failures are recorded, so an agent's malformed configuration cannot
// prevent its invalid sample (or subsequent samples) from being persisted.
export async function analyzeEvaluation(project, before, removals) {
  const result = {after: null, duplications: null, newDuplications: null, duplicationError: null, cleanup: []};
  try {
    result.after = snapshot(project);
    const index = indexSources(result.after, project, before.files);
    assert.deepEqual(index.errors, []);
    const duplications = newClones(before, result.after, await clones(result.after));
    const cleanup = cleanupFindings(before, result.after, indexSources(before), index, removals);
    Object.assign(result, {duplications, newDuplications: duplications.length, cleanup});
  } catch (error) {
    result.duplicationError = (error instanceof Error ? error.message : String(error)) || 'Source analysis failed';
  }
  return result;
}
