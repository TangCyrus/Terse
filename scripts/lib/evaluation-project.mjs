import fs from 'node:fs';
import path from 'node:path';
import {createWorkspace, repository} from './workspace.mjs';

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
