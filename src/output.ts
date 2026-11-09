import { VERSION, type Status } from './types.js';
import path from 'node:path';
import type { DecisionIssue } from './decision.js';
import type { check } from './check.js';

export const EXIT_CODES: Record<Status, number> = { pass: 0, fail: 1, 'needs-review': 2, incomplete: 3 };
export type Command = 'init' | 'begin' | 'context' | 'decide' | 'simplify' | 'check' | 'help' | 'version';
export type ErrorStage = 'arguments' | 'project' | 'command';
export interface Diagnostic {
  code: 'INVALID_ARGUMENT' | 'PROJECT_ERROR' | 'COMMAND_ERROR' | 'CONTEXT_INCOMPLETE' | 'CHECK_INCOMPLETE';
  message: string;
  stage: ErrorStage;
  causeCode?: string;
  issues?: DecisionIssue[];
}
export interface CliOutput {
  [key: string]: unknown;
  schemaVersion: 1;
  toolVersion: string;
  command: Command | null;
  outputKind: 'result' | 'error';
  status: Status;
  exitCode: number;
  errors: string[];
  diagnostics: Diagnostic[];
}

export function verificationGuide(root: string, run: string) {
  return {argvTemplate: ['check', '--cwd', root, '--run', run, '--summary', '--json'], verificationOwner: 'check',
    notes: 'Check runs all baseline verification and static checks; do not duplicate configured tests manually by default. Begin --query already includes context. Inspect failureOutput/errors before targeted debugging; rerun the full check after fixes or relevant input/environment changes. Repeating unchanged checks cannot resolve review-only findings. No result cache.'};
}

export function summaryOutput(root: string, report: Awaited<ReturnType<typeof check>>) {
  let remaining = 4096;
  return {...report, detail: 'summary', reportPath: path.join(root, '.terse/runs', report.run, 'report.json'),
    verification: report.verification.map(({output, ...item}) => {
      if (item.status === 'passed') return {...item, outputOmitted: true};
      const limit = Math.min(2048, remaining);
      const marker = '\n… output omitted …\n';
      const tail = Math.floor((limit - marker.length) / 2);
      const excerpt = output.length <= limit ? output : limit < marker.length ? ''
        : output.slice(0, limit - marker.length - tail) + marker + (tail ? output.slice(-tail) : '');
      remaining -= excerpt.length;
      return {...item, outputOmitted: true, failureOutput: excerpt, failureOutputTruncated: excerpt.length < output.length};
    })};
}

export function resultOutput(command: Command, payload: Record<string, unknown>): CliOutput {
  const errors = (payload.errors ?? []) as string[];
  const status = (payload.status ?? (errors.length ? 'incomplete' : 'pass')) as Status;
  return { ...payload, schemaVersion: 1, toolVersion: VERSION, command, outputKind: 'result',
    status, exitCode: EXIT_CODES[status], errors,
    diagnostics: errors.map(message => ({ code: command === 'context' || (command === 'begin' && payload.context) ? 'CONTEXT_INCOMPLETE' : 'CHECK_INCOMPLETE', message, stage: 'command' })),
  };
}

export function errorOutput(command: Command | null, stage: ErrorStage, error: unknown): CliOutput {
  const message = error instanceof Error ? error.message : String(error);
  const causeCode = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const code = ({ arguments: 'INVALID_ARGUMENT', project: 'PROJECT_ERROR', command: 'COMMAND_ERROR' } as const)[stage];
  const issues = error instanceof Error && 'issues' in error && Array.isArray(error.issues) ? error.issues as DecisionIssue[] : undefined;
  return { schemaVersion: 1, toolVersion: VERSION, command, outputKind: 'error', status: 'incomplete', exitCode: 3,
    errors: [message], diagnostics: [{ code, message, stage, ...(causeCode ? { causeCode } : {}), ...(issues ? { issues } : {}) }] };
}
