import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ANALYZER, type Baseline, type Config, type Snapshot } from './types.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const slash = (value: string) => value.replaceAll('\\', '/');
const sourcePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const defaultExcluded = new Set(['.git', '.terse', 'node_modules', 'dist', 'build', 'coverage', 'vendor', '.next']);
const runIdPattern = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const skipReasons = new Set(['excluded', 'unsupported-or-declaration', 'symlink', 'not-a-file', 'over-1MiB', 'non-utf8', 'binary']);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const relativePath = (value: string) => !/[\\\0]/.test(value) && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
  && !/^[a-z]:/i.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const ordered = <T>(value: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
const recordError = (code: string, message: string) => Object.assign(new Error(`[${code}] ${message}`), { code });

// Keep the schema-1 serialization used by existing runs; JSON object order is not data.
function snapshotHash(state: Omit<Snapshot, 'hash'>): string {
  return digest(JSON.stringify({ files: Object.entries(ordered(state.files)).map(([p, s]) => [p, s.hash]),
    metadata: ordered(state.metadata), config: state.config, skipped: state.skipped.map(({ path, reason }) => ({ path, reason })) }));
}

export function rootOf(cwd: string): string {
  return fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim());
}

export function readJson(file: string): any {
  let content: string;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('expected a regular file; symlinks are not followed');
    content = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  } catch (error) {
    const detail = error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.message) : 'unreadable file';
    throw recordError('JSON_READ_FAILED', `${file}: ${detail}`);
  }
  try { return JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { throw recordError('INVALID_JSON', `${file}: expected valid JSON; file contents are omitted`); }
}

export function parseConfig(raw: unknown, complete = false): Config {
  if (!isRecord(raw)) throw new Error('config must be an object');
  const allowed = new Set(['exclude', 'minTokens', 'minLines', 'duplicatePolicy', 'verification']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unknown config option: ${key}`);
  if (complete) for (const key of allowed) if (!Object.hasOwn(raw, key) || raw[key] === null) throw new Error(`config.${key} is required`);
  const exclude = raw.exclude ?? [];
  const minTokens = raw.minTokens ?? 50;
  const minLines = raw.minLines ?? 5;
  const duplicatePolicy = raw.duplicatePolicy ?? 'review';
  const commands = raw.verification ?? [];
  if (!Array.isArray(exclude) || exclude.some(p => typeof p !== 'string' || !p.trim() || /[*?]/.test(p) || !relativePath(p.replace(/\/$/, '')))) {
    throw new Error('exclude must contain relative file/directory prefixes using forward slashes (no globs)');
  }
  if (typeof minTokens !== 'number' || !Number.isInteger(minTokens) || minTokens < 10 || typeof minLines !== 'number' || !Number.isInteger(minLines) || minLines < 1) {
    throw new Error('minTokens must be >= 10 and minLines >= 1');
  }
  if (duplicatePolicy !== 'review' && duplicatePolicy !== 'fail') throw new Error('Invalid duplicatePolicy');
  if (!Array.isArray(commands)) throw new Error('verification must be an array');
  const verification = commands.map((v: unknown, i) => {
    if (!isRecord(v) || typeof v.command !== 'string' || !v.command.trim() || !Array.isArray(v.args) || v.args.some(a => typeof a !== 'string')) {
      throw new Error(`verification[${i}] needs a command and an array of string args`);
    }
    if (complete && (!Object.hasOwn(v, 'timeoutMs') || v.timeoutMs === null)) throw new Error(`verification[${i}].timeoutMs is required`);
    const timeoutMs = v.timeoutMs ?? 30_000;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error(`verification[${i}].timeoutMs must be 100..300000`);
    return { command: v.command, args: v.args, timeoutMs };
  });
  return { exclude, minTokens, minLines, duplicatePolicy, verification };
}

export function configOf(root: string): Config {
  const file = path.join(root, 'terse.config.json');
  return parseConfig(fs.existsSync(file) ? readJson(file) : {});
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
  return { files, metadata, hash: snapshotHash({ files, metadata, config, skipped }), skipped, config };
}

export function runDir(root: string, run: string, create = false): string {
  if (!runIdPattern.test(run)) throw recordError('INVALID_RUN_ID', 'Expected the run ID returned by terse begin');
  let current = root;
  for (const part of ['.terse', 'runs', run]) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe run directory: ${current}`);
    } else if (create) fs.mkdirSync(current);
    else throw recordError('RUN_NOT_FOUND', `${current}: restore the run or use terse begin`);
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
  if (typeof task !== 'string' || !task.trim()) throw new Error('A non-empty task is required');
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
  const file = path.join(dir, 'baseline.json');
  const recover = 'Restore the original record or start a new run with terse begin; do not regenerate hashes to hide corruption.';
  function fail(code: string, field: string, detail: string): never { throw recordError(code, `${file} ${field}: ${detail}. ${recover}`); }
  function require(ok: unknown, field: string, detail: string): asserts ok { if (!ok) fail('BASELINE_INVALID', field, detail); }
  let raw: unknown;
  try { raw = readJson(file); }
  catch (error) {
    if (error instanceof Error) { error.message += `. ${recover}`; throw error; }
    throw new Error(`${String(error)}. ${recover}`);
  }
  require(isRecord(raw), 'document', 'expected an object');
  for (const [field, expected] of Object.entries({ schema: 1, analyzer: ANALYZER, run, root })) {
    if (raw[field] !== expected) fail('BASELINE_INCOMPATIBLE', field, 'does not match this run, repository or supported version');
  }
  require(typeof raw.task === 'string' && raw.task.trim(), 'task', 'expected a non-empty string');
  require(typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)), 'createdAt', 'expected an ISO timestamp');
  require(new Date(raw.createdAt).toISOString() === raw.createdAt, 'createdAt', 'expected an ISO timestamp');
  require(raw.head === null || (typeof raw.head === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(raw.head)), 'head', 'expected a Git object ID or null');
  const state = raw.snapshot;
  require(isRecord(state), 'snapshot', 'expected an object');
  require(isRecord(state.files), 'snapshot.files', 'expected a path-to-source object');
  require(isRecord(state.metadata), 'snapshot.metadata', 'expected a path-to-hash object');
  require(Array.isArray(state.skipped), 'snapshot.skipped', 'expected an array');
  require(typeof state.hash === 'string' && hashPattern.test(state.hash), 'snapshot.hash', 'expected a SHA-256 hash');
  const seen = new Set<string>();
  function validatePath(value: unknown, field: string): asserts value is string {
    require(typeof value === 'string' && relativePath(value), field, 'expected a normalized repository-relative path');
    require(!seen.has(value), field, 'path appears in multiple snapshot entries');
    seen.add(value);
  }
  for (const [name, source] of Object.entries(state.files)) {
    const field = `snapshot.files[${JSON.stringify(name)}]`;
    validatePath(name, field);
    require(isRecord(source) && typeof source.content === 'string' && typeof source.hash === 'string' && hashPattern.test(source.hash), field, 'expected content and SHA-256 hash');
    if (digest(source.content) !== source.hash) fail('BASELINE_INTEGRITY', field, 'source content does not match its hash');
  }
  for (const [name, hash] of Object.entries(state.metadata)) {
    const field = `snapshot.metadata[${JSON.stringify(name)}]`;
    validatePath(name, field);
    require(typeof hash === 'string' && hashPattern.test(hash), field, 'expected a SHA-256 hash');
  }
  for (const [i, entry] of state.skipped.entries()) {
    const field = `snapshot.skipped[${i}]`;
    require(isRecord(entry), field, 'expected an object');
    validatePath(entry.path, `${field}.path`);
    require(typeof entry.reason === 'string' && skipReasons.has(entry.reason), `${field}.reason`, 'unknown skip reason');
  }
  let config: Config;
  try { config = parseConfig(state.config, true); }
  catch (error) { fail('BASELINE_INVALID', 'snapshot.config', error instanceof Error ? error.message : 'invalid config'); }
  const baseline = raw as unknown as Baseline;
  // Normalize object key order before downstream policy comparisons and token scanning.
  baseline.snapshot = { ...baseline.snapshot, files: ordered(baseline.snapshot.files), metadata: ordered(baseline.snapshot.metadata), config };
  if (snapshotHash(baseline.snapshot) !== baseline.snapshot.hash) {
    fail('BASELINE_INTEGRITY', 'snapshot.hash', 'snapshot contents do not match the saved aggregate hash');
  }
  return { dir, baseline };
}
