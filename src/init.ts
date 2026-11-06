import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { configOf, parseConfig } from './project.js';

const skillPath = '.agents/skills/terse';
const start = '<!-- terse:begin -->', end = '<!-- terse:end -->';
const instruction = `${start}
## Terse development workflow

For JavaScript/TypeScript feature, bug-fix, deletion and refactoring requests, read
[the Terse skill](.agents/skills/terse/SKILL.md) before editing source, even when the
request does not mention Terse. Use it to retrieve existing code, record the actual
reuse decision, and run the full check after implementing the requested behavior.
Documentation-only questions do not require this workflow. Respect the user's
scope and the other project instructions.
${end}`;

type PlannedFile = { path: string; content: string; previous?: string; status: 'created' | 'updated' | 'unchanged' | 'preserved' };

// Preflight every managed path before making any change, including dangling links.
function contentOf(root: string, relative: string): string | undefined {
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Cannot initialize ${relative}: ${current} must be a regular ${index < parts.length - 1 ? 'directory' : 'file'}`);
    }
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(current));
}

export function init(root: string, verification?: unknown[]) {
  const plan: PlannedFile[] = [];
  function put(relative: string, content: string, mode: 'exact' | 'append' | 'runtime' = 'exact') {
    const previous = contentOf(root, relative);
    if (previous !== undefined && mode === 'exact') {
      if (previous.replaceAll('\r\n', '\n') !== content.replaceAll('\r\n', '\n')) {
        throw new Error(`Cannot initialize ${relative}: existing content differs; preserve or relocate your file before installing the bundled Terse version`);
      }
      content = previous; // Git/package line-ending differences are not user edits.
    }
    plan.push({path: relative, content, previous, status: previous === undefined ? 'created' : previous === content ? 'unchanged' : 'updated'});
  }
  const existingConfig = contentOf(root, 'terse.config.json');
  if (existingConfig !== undefined && verification !== undefined) throw new Error('--verify only configures a new terse.config.json; edit the existing project configuration explicitly');
  const config = existingConfig === undefined ? parseConfig({verification: verification ?? []}) : configOf(root);
  if (existingConfig === undefined) put('terse.config.json', JSON.stringify(config, null, 2) + '\n');
  else plan.push({path: 'terse.config.json', content: existingConfig, previous: existingConfig, status: 'preserved'});

  for (const relative of ['SKILL.md', 'agents/openai.yaml', 'scripts/run.mjs']) {
    put(`${skillPath}/${relative}`, fs.readFileSync(new URL(`../skills/terse/${relative}`, import.meta.url), 'utf8'));
  }
  const override = contentOf(root, 'AGENTS.override.md');
  const instructionsPath = override?.trim() ? 'AGENTS.override.md' : 'AGENTS.md';
  const existingInstructions = contentOf(root, instructionsPath) ?? '';
  const newline = existingInstructions.includes('\r\n') ? '\r\n' : '\n';
  const block = instruction.replaceAll('\n', newline);
  let instructions = existingInstructions;
  if (instructions.includes(start) || instructions.includes(end)) {
    if (instructions.split(start).length !== 2 || instructions.split(end).length !== 2 || !instructions.includes(block)) {
      throw new Error(`Cannot initialize ${instructionsPath}: the existing Terse block differs; reconcile it explicitly`);
    }
  } else instructions += `${instructions ? (instructions.endsWith('\n') ? newline : newline + newline) : ''}${block}${newline}`;
  put(instructionsPath, instructions, 'append');

  let ignore = contentOf(root, '.gitignore') ?? '';
  let ignored = false;
  try { execFileSync('git', ['check-ignore', '--no-index', '-q', '--', '.terse/'], {cwd: root, stdio: 'pipe'}); ignored = true; }
  catch (error) { if ((error as {status?: number}).status !== 1) throw error; }
  if (!ignored) ignore += `${ignore && !ignore.endsWith('\n') ? '\n' : ''}/.terse/\n`;
  put('.gitignore', ignore, 'append');

  const runtime = '.terse/agent.json';
  const previousRuntime = contentOf(root, runtime);
  if (previousRuntime !== undefined) {
    const previous = JSON.parse(previousRuntime);
    if (previous?.schemaVersion !== 1 || typeof previous.cli !== 'string' || Object.keys(previous).some(key => !['schemaVersion', 'cli'].includes(key))) {
      throw new Error(`Cannot initialize ${runtime}: expected a Terse CLI binding`);
    }
  }
  put(runtime, JSON.stringify({schemaVersion: 1, cli: path.relative(root, fileURLToPath(new URL('./cli.js', import.meta.url))).replaceAll('\\', '/')}, null, 2) + '\n', 'runtime');

  for (const file of plan) if (file.status === 'created' || file.status === 'updated') {
    fs.mkdirSync(path.dirname(path.join(root, file.path)), {recursive: true});
    fs.writeFileSync(path.join(root, file.path), file.content, {flag: file.status === 'created' ? 'wx' : 'w'});
  }
  const verificationConfigured = config.verification.length > 0;
  return {root, skillPath: `${skillPath}/SKILL.md`, instructionsPath, runnerArgv: ['node', `${skillPath}/scripts/run.mjs`],
    files: plan.map(({path, status}) => ({path, status})), verificationConfigured,
    status: verificationConfigured ? 'pass' as const : 'needs-review' as const,
    setupIssues: verificationConfigured ? [] : [{code: 'VERIFICATION_NOT_CONFIGURED', message: 'Configure real project verification commands in terse.config.json before begin; none were guessed or executed.'}],
    next: 'Open a new agent session in this project to load its instructions. For a normal JS/TS development request, use the installed Terse skill. Run init on each checkout to bind its local CLI.'};
}
