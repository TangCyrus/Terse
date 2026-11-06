import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {summarizeEvents} from './agent-events.mjs';
import {StringDecoder} from 'node:string_decoder';

// Shared transport for real experiments; fixtures and independent grading stay with each suite.
export async function runAgent({project, prompt, directory, codex, specification, terseCli, env, onEvent}) {
  const args = ['exec', '--ephemeral', '--approve-for-me',
    '--disable', 'multi_agent', '--json', '--color', 'never', '-m', specification.model,
    '-c', `model_reasoning_effort="${specification.reasoningEffort}"`, '-C', project, '-'];
  fs.writeFileSync(path.join(directory, 'prompt.txt'), prompt);
  const start = performance.now();
  const stdout = fs.createWriteStream(path.join(directory, 'agent.jsonl'));
  const stderr = fs.createWriteStream(path.join(directory, 'agent.stderr.log'));
  const child = spawn(codex, args, {cwd: project, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  // Optional parent-only observation; never injects instructions or tool results.
  const observationErrors = [];
  let pending = '';
  const decoder = new StringDecoder('utf8');
  const observe = line => {
    if (!line.trim()) return;
    try { onEvent(JSON.parse(line)); }
    catch (error) { observationErrors.push(error instanceof Error ? error.message : String(error)); }
  };
  if (onEvent) child.stdout.on('data', chunk => {
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      observe(pending.slice(0, newline)); pending = pending.slice(newline + 1);
    }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  let timedOut = false;
  const heartbeat = setInterval(() => console.error(`Agent still running: ${path.basename(directory)} (${Math.round((performance.now() - start) / 1000)}s)`), 30_000);
  const timeout = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGKILL');
  }, specification.timeoutMs);
  const exit = await new Promise(resolve => {
    child.once('error', error => resolve({exitCode: null, error: error.message}));
    child.once('close', (exitCode, signal) => resolve({exitCode, signal}));
  });
  clearTimeout(timeout); clearInterval(heartbeat);
  if (onEvent) observe(pending + decoder.end());
  await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
  const events = summarizeEvents(fs.readFileSync(path.join(directory, 'agent.jsonl'), 'utf8'), terseCli);
  const blockedByPolicy = /blocked by policy/.test(fs.readFileSync(path.join(directory, 'agent.stderr.log'), 'utf8'));
  return {...exit, timedOut, blockedByPolicy, agentMs: Math.round(performance.now() - start), events,
    ...(onEvent ? {observationErrors} : {})};
}
