import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { clones, indexSources, newClones } from './analyze.js';
import { loadRun, readJson, snapshot, writeJson } from './project.js';
import { ANALYZER, type Decision, type Finding, type Status, type VerificationResult } from './types.js';
import { cleanupFindings } from './cleanup.js';

function readDecision(file: string): Decision | null {
  const d = readJson(file);
  if (!d || !['reuse', 'modify', 'refactor', 'new'].includes(d.strategy) || typeof d.rationale !== 'string' || !d.rationale.trim()
    || !Array.isArray(d.considered) || !Array.isArray(d.remove)) return null;
  if (d.considered.some((c: any) => !c || typeof c.path !== 'string' || typeof c.symbol !== 'string' || !['reuse', 'modify', 'reject'].includes(c.disposition)
    || typeof c.reason !== 'string' || !c.reason.trim())) return null;
  if (d.remove.some((r: any) => !r || typeof r.path !== 'string' || (r.symbol !== undefined && typeof r.symbol !== 'string'))) return null;
  return d;
}

export async function check(root: string, run: string, skipVerification = false) {
  const { dir, baseline } = loadRun(root, run);
  const before = baseline.snapshot;
  const after = snapshot(root);
  const findings: Finding[] = [];
  const errors: string[] = [];
  const verification: VerificationResult[] = [];
  const add = (rule: string, message: string, locations: Finding['locations'] = [], severity: Finding['severity'] = 'review') => findings.push({ rule, message, locations, severity });
  const changes = {
    added: Object.keys(after.files).filter(p => !Object.hasOwn(before.files, p)),
    modified: Object.keys(after.files).filter(p => before.files[p] && before.files[p].hash !== after.files[p].hash),
    deleted: Object.keys(before.files).filter(p => !Object.hasOwn(after.files, p)),
  };
  if (JSON.stringify(before.config) !== JSON.stringify(after.config)) errors.push('terse.config.json changed during this run; start a new run after reviewing the policy change');
  const oldIndex = indexSources(before);
  const newIndex = indexSources(after, root, before.files);
  errors.push(...oldIndex.errors.map(e => `Baseline parse error: ${e}`), ...newIndex.errors.map(e => `Current analysis error: ${e}`));
  if (!Object.keys(after.files).length) add('NO_SOURCE_FILES', 'No supported source files remain; deletion requires explicit review.');
  const gaps = after.skipped.filter(s => !['excluded', 'unsupported-or-declaration'].includes(s.reason));
  if (gaps.length) add('COVERAGE_GAP', 'Some source files could not be scanned; see skipped files.', gaps.map(s => ({ path: s.path })));

  const evidencePath = path.join(dir, 'context.json');
  const evidence = fs.existsSync(evidencePath) ? readJson(evidencePath) : [];
  if (!Array.isArray(evidence)) errors.push('Invalid context evidence');
  else if (!evidence.some(e => e?.snapshotHash === before.hash && Array.isArray(e.errors) && !e.errors.length)) {
    add('CONTEXT_MISSING', 'No successful context search was recorded against the task baseline.');
  }
  const decision = readDecision(path.join(dir, 'decision.json'));
  if (!decision) add('DECISION_MISSING', 'Complete decision.json with a strategy, rationale, considered candidates and removal targets.');
  else {
    if (decision.strategy !== 'new' && !decision.considered.some(c => c.disposition !== 'reject')) add('DECISION_UNSUPPORTED', 'Reuse/modify/refactor requires at least one existing candidate.');
    for (const c of decision.considered) {
      if (!oldIndex.symbols.some(s => s.path === c.path && s.symbol === c.symbol)) add('CANDIDATE_NOT_FOUND', `Baseline candidate not found: ${c.symbol}`, [{ path: c.path, symbol: c.symbol }]);
    }
    if (decision.remove.length && !errors.length) findings.push(...cleanupFindings(before, after, oldIndex, newIndex, decision.remove));
  }

  let baselineClones = 0;
  let currentClones = 0;
  if (!errors.length) {
    try {
      const previous = await clones(before);
      const current = await clones(after);
      baselineClones = previous.length;
      currentClones = current.length;
      for (const clone of newClones(before, after, current)) {
        findings.push({ rule: 'NEW_DUPLICATION', message: `Token occurrences increased from ${clone.attribution.baselineOccurrences} to ${clone.attribution.currentOccurrences}; review reuse before retaining these implementations.`,
          locations: clone.locations, attribution: clone.attribution, severity: before.config.duplicatePolicy === 'fail' ? 'fail' : 'review' });
      }
    } catch (error) { errors.push(`Duplicate detector failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  if (skipVerification || !before.config.verification.length) add('VERIFICATION_MISSING', skipVerification ? 'Configured verification was explicitly skipped.' : 'No verification commands were configured before begin.');
  else if (!errors.length) {
    for (const command of before.config.verification) {
      const result = spawnSync(command.command === 'node' ? process.execPath : command.command, command.args, {
        cwd: root, encoding: 'utf8', shell: false, timeout: command.timeoutMs, maxBuffer: 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      const item: VerificationResult = { command, exitCode: result.status,
        status: result.error || result.signal ? 'error' : result.status === 0 ? 'passed' : 'failed',
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(0, 12000),
        ...(result.error || result.signal ? { error: result.error?.message ?? `Terminated by ${result.signal}` } : {}),
      };
      verification.push(item);
      if (item.status === 'error') errors.push(`Verification could not complete: ${item.error}`);
      if (item.status === 'failed') add('VERIFICATION_FAILED', `Verification exited ${item.exitCode}: ${command.command} ${command.args.join(' ')}`, [], 'fail');
    }
  }
  if (snapshot(root).hash !== after.hash) errors.push('Project changed during check; results are stale. Run check again on a stable workspace.');
  const status: Status = errors.length ? 'incomplete' : findings.some(f => f.severity === 'fail') ? 'fail' : findings.length ? 'needs-review' : 'pass';
  const report = { command: 'check', run, task: baseline.task, status, analyzer: ANALYZER, checkedAt: new Date().toISOString(),
    baselineHash: before.hash, snapshotHash: after.hash, attributionAlgorithm: 'token-occurrences/1', scannedFiles: Object.keys(after.files).length,
    baselineFiles: Object.keys(before.files).length, changes, baselineClones, currentClones,
    newDuplications: findings.filter(f => f.rule === 'NEW_DUPLICATION').length, findings, errors, verification, skipped: after.skipped,
    limitations: ['Token clone detection ignores whitespace/comments; it does not prove semantic equivalence.',
      'Exact token occurrence counts suppress historical fragments and moves; equal-count relocation cannot be distinguished from deleting and copying the same tokens.',
      'Removal checks use M2 module resolution, direct named exports and unbound same-file calls; unresolved imports need review. No complete call graph or external consumer analysis.',
      'This report applies only to the recorded snapshot. Local evidence is not a tamper-proof CI attestation.'],
  };
  writeJson(dir, 'report.json', report);
  return report;
}
