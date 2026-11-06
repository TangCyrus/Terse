import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
try {
  const binding = JSON.parse(fs.readFileSync(path.join(root, '.terse/agent.json'), 'utf8'));
  if (binding.schemaVersion !== 1 || typeof binding.cli !== 'string' || !binding.cli.trim()) throw Error('invalid CLI binding');
  const cli = path.resolve(root, binding.cli);
  if (!fs.statSync(cli).isFile()) throw Error('CLI is not a file');
  const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {cwd: root, stdio: 'inherit'});
  if (result.error || result.signal) throw result.error ?? Error(`CLI terminated by ${result.signal}`);
  process.exitCode = result.status ?? 3;
} catch (error) {
  console.error(`Terse launcher: ${error.message}. Rerun the installed Terse CLI's init --cwd <project> to restore .terse/agent.json.`);
  process.exitCode = 3;
}
