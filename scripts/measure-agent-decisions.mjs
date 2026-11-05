import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {repository} from './lib/workspace.mjs';
import {summarizeEvents} from './lib/agent-events.mjs';

const {values} = parseArgs({options: {report: {type: 'string'}, events: {type: 'string'}, output: {type: 'string'}, 'terse-cli': {type: 'string'}}});
assert(values.report && values.events && values.output, 'Pass --report <published comparison.json> --events <raw artifact directory> --output <new file>');
const digest = value => createHash('sha256').update(value).digest('hex');
const reportBytes = fs.readFileSync(values.report);
const report = JSON.parse(reportBytes);
assert.equal(report.kind, 'open-source-agent-comparison');
const results = report.results.map(run => {
  const artifactId = run.artifactId ?? `pair-${run.repetition}-${run.arm}`;
  assert(/^[a-z0-9-]+$/.test(artifactId));
  const bytes = fs.readFileSync(path.join(values.events, artifactId, 'agent.jsonl'));
  assert.equal(digest(bytes), run.evidence.eventHash, `Raw event hash mismatch: ${artifactId}`);
  return {artifactId, taskId: run.taskId, repetition: run.repetition, arm: run.arm, eventHash: run.evidence.eventHash,
    decisions: summarizeEvents(bytes.toString('utf8'), values['terse-cli'] ?? path.join(repository, 'dist/cli.js')).decisions};
});
fs.writeFileSync(values.output, JSON.stringify({measurement: 'terse-decisions/1', reportHash: digest(reportBytes), results}, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({runs: results.length, output: values.output}));
