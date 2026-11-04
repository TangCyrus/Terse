import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ANALYZER, type Baseline, type Config, type Snapshot } from './types.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const slash = (value: string) => value.replaceAll('\\', '/');
const sourcePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const defaultExcluded = new Set(['.git', '.terse', 'node_modules', 'dist', 'build', 'coverage', 'vendor', '.next']);

export function rootOf(cwd: string): string {
  return fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim());
}

export function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function configOf(root: string): Config {
  const file = path.join(root, 'terse.config.json');
  const raw = fs.existsSync(file) ? readJson(file) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('terse.config.json must be an object');
  const allowed = new Set(['exclude', 'minTokens', 'minLines', 'duplicatePolicy', 'verification']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unknown config option: ${key}`);
  const config: Config = {
    exclude: raw.exclude ?? [], minTokens: raw.minTokens ?? 50, minLines: raw.minLines ?? 5,
    duplicatePolicy: raw.duplicatePolicy ?? 'review', verification: raw.verification ?? [],
  };
  if (!Array.isArray(config.exclude) || config.exclude.some(p => typeof p !== 'string' || !p.trim() || p.includes('..') || /[\\*?]/.test(p) || path.isAbsolute(p))) {
    throw new Error('exclude must contain relative file/directory prefixes using forward slashes (no globs)');
  }
  if (!Number.isInteger(config.minTokens) || config.minTokens < 10 || !Number.isInteger(config.minLines) || config.minLines < 1) {
    throw new Error('minTokens must be >= 10 and minLines >= 1');
  }
  if (!['review', 'fail'].includes(config.duplicatePolicy) || !Array.isArray(config.verification)) throw new Error('Invalid policy or verification list');
  config.verification = config.verification.map(v => {
    if (!v || typeof v.command !== 'string' || !v.command.trim() || !Array.isArray(v.args) || v.args.some(a => typeof a !== 'string')) {
      throw new Error('Each verification needs a command and an array of string args');
    }
    const timeoutMs = v.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error('verification timeoutMs must be 100..300000');
    return { command: v.command, args: v.args, timeoutMs };
  });
  return config;
}

export function snapshot(root: string): Snapshot {
  const config = configOf(root);
  const names = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).split('\0').filter(Boolean))].sort();
  const files: Snapshot['files'] = {};
  const metadata: Snapshot['metadata'] = {};
  const skipped: Snapshot['skipped'] = [];
  for (const name of names) {
    const relative = slash(name);
    const parts = relative.split('/');
    if (parts.includes('.terse')) continue;
    if (parts.some(p => defaultExcluded.has(p)) || config.exclude.some(p => relative === p.replace(/\/$/, '') || relative.startsWith(`${p.replace(/\/$/, '')}/`))) {
      skipped.push({ path: relative, reason: 'excluded' }); continue;
    }
    const isMetadata = /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|jsconfig\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(relative);
    if (!isMetadata && (!sourcePattern.test(relative) || /\.d\.[cm]?ts$|\.min\.[cm]?js$/i.test(relative))) {
      skipped.push({ path: relative, reason: 'unsupported-or-declaration' }); continue;
    }
    // Do not traverse symlinks, including a directory replaced after git indexed it.
    let current = root;
    let unsafe = false;
    for (const part of parts) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) { unsafe = true; break; }
      if (fs.lstatSync(current).isSymbolicLink()) { skipped.push({ path: relative, reason: 'symlink' }); unsafe = true; break; }
    }
    if (unsafe) continue;
    const stat = fs.statSync(current);
    if (!stat.isFile()) { skipped.push({ path: relative, reason: 'not-a-file' }); continue; }
    if (stat.size > 1024 * 1024) { skipped.push({ path: relative, reason: 'over-1MiB' }); continue; }
    const bytes = fs.readFileSync(current);
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { skipped.push({ path: relative, reason: 'non-utf8' }); continue; }
    if (content.includes('\0')) { skipped.push({ path: relative, reason: 'binary' }); continue; }
    if (isMetadata) metadata[relative] = digest(content);
    else files[relative] = { content, hash: digest(content) };
  }
  const hash = digest(JSON.stringify({ files: Object.entries(files).map(([p, s]) => [p, s.hash]), metadata, config, skipped }));
  return { files, metadata, hash, skipped, config };
}

export function runDir(root: string, run: string, create = false): string {
  if (!/^\d{13}-[0-9a-f-]{36}$/.test(run)) throw new Error('Invalid run id');
  let current = root;
  for (const part of ['.terse', 'runs', run]) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe run directory: ${current}`);
    } else if (create) fs.mkdirSync(current);
    else throw new Error(`Run not found: ${run}`);
  }
  return current;
}

export function writeJson(dir: string, name: string, value: unknown): void {
  const target = path.join(dir, name);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`Refusing symlink: ${target}`);
  const temp = `${target}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temp, target);
}

export function begin(root: string, task: string) {
  const state = snapshot(root);
  const run = `${Date.now()}-${randomUUID()}`;
  const dir = runDir(root, run, true);
  let head: string | null = null;
  try { head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* unborn repository */ }
  const baseline: Baseline = { schema: 1, analyzer: ANALYZER, run, root, task, createdAt: new Date().toISOString(), head, snapshot: state };
  writeJson(dir, 'baseline.json', baseline);
  writeJson(dir, 'decision.json', { strategy: '', rationale: '', considered: [], remove: [] });
  return { command: 'begin', run, task, root, head, scannedFiles: Object.keys(state.files).length, snapshotHash: state.hash,
    skipped: state.skipped, decisionPath: path.join(dir, 'decision.json'),
    next: `terse context --run ${run} --query "<behavior or symbol>"` };
}

export function loadRun(root: string, run: string): { dir: string; baseline: Baseline } {
  const dir = runDir(root, run);
  const baseline = readJson(path.join(dir, 'baseline.json')) as Baseline;
  if (baseline.schema !== 1 || baseline.analyzer !== ANALYZER || baseline.run !== run || baseline.root !== root || !baseline.snapshot?.files) {
    throw new Error('Run schema, analyzer or repository mismatch; start a new run');
  }
  for (const [file, source] of Object.entries(baseline.snapshot.files)) {
    if (path.isAbsolute(file) || file.includes('..') || file.includes('\\') || typeof source.content !== 'string' || digest(source.content) !== source.hash) {
      throw new Error('Invalid or corrupted baseline source');
    }
  }
  return { dir, baseline };
}
