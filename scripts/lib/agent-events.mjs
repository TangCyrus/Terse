// Keep protocol parsing separate from execution so CI never needs credentials or a live model.
export function summarizeEvents(text, terseCli) {
  const events = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('Invalid event');
      events.push(event);
    } catch { malformed++; }
  }
  const completions = events.filter(event => event.type === 'turn.completed');
  const failed = events.some(event => event.type === 'turn.failed');
  const measuredUsage = {};
  for (const event of completions) for (const [name, value] of Object.entries(event.usage ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) measuredUsage[name] = (measuredUsage[name] ?? 0) + value;
  }
  const usage = Object.keys(measuredUsage).length ? measuredUsage : null;
  const completed = completions.length > 0 && !failed && malformed === 0;
  return { completed, malformed, usage,
    errors: events.filter(event => event.type === 'error' || event.item?.type === 'error').map(event => event.message ?? event.item.message),
    commandCount: events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution').length,
    finalMessage: events.filter(event => event.item?.type === 'agent_message').at(-1)?.item.text ?? null,
    ...(terseCli ? {decisions: decisionActivity(events, terseCli, completed), checks: checkActivity(events, completed)} : {}) };
}

// Preserve raw phase logs separately; prefix only derived references so repeated
// item IDs from independent ephemeral sessions cannot be confused in a report.
export function summarizePhases(phases, terseCli) {
  const summaries = phases.map(({text}) => summarizeEvents(text, terseCli));
  const lines = phases.flatMap(({phase, text}) => text.split(/\r?\n/).filter(Boolean).map(line => {
    try {
      const event = JSON.parse(line);
      if (event?.item && typeof event.item.id === 'string') event.item.id = `${phase}:${event.item.id}`;
      return JSON.stringify(event);
    } catch { return line; }
  }));
  const result = summarizeEvents(lines.join('\n'), terseCli);
  if (!summaries.every(item => item.completed)) {
    result.completed = false;
    if (result.decisions) Object.assign(result.decisions, {complete: false, retries: null, unrecoveredFailure: null});
    if (result.checks) result.checks.complete = false;
  }
  return result;
}

// Tool output may contain several pretty-printed CLI objects and shell preambles.
// Do not count help, source reads, decision-input filenames or ordinary successful revisions as retries.
function jsonObjects(text) {
  const objects = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < text.length; end++) {
      const character = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try { objects.push(JSON.parse(text.slice(start, end + 1))); start = end; } catch { /* Try later JSON starts. */ }
        break;
      }
    }
  }
  return objects;
}

function decisionActivity(events, terseCli, completed) {
  const normalize = value => value.replace(/['"]/g, '').replaceAll('\\', '/').replace(/\/+/g, '/');
  const escapedCli = normalize(terseCli).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const invocation = new RegExp(`${escapedCli}[/'"\\s]*decide\\s+(?=--)`, 'g');
  const attempts = [];
  let helpCalls = 0;
  for (const event of events) {
    const item = event.item;
    if (event.type !== 'item.completed' || item?.type !== 'command_execution') continue;
    const command = normalize(item.command ?? '');
    const calls = [...command.matchAll(invocation)];
    if (!calls.length && !/\bdecide\s+--/.test(command)) continue;
    const responses = jsonObjects(item.aggregated_output ?? '').filter(value => value.schemaVersion === 1 && value.command === 'decide');
    const helps = calls.length ? calls.filter((call, index) => /--(?:help|version)\b/.test(command.slice(call.index + call[0].length, calls[index + 1]?.index))).length
      : /--(?:help|version)\b/.test(command) ? 1 : 0;
    helpCalls += helps;
    for (const [index, response] of responses.entries()) {
      const outcome = response.outputKind === 'result' && response.exitCode === 0 && response.status === 'pass' ? 'saved'
        : response.outputKind === 'error' && response.exitCode === 3 ? 'rejected' : 'unknown';
      attempts.push({itemId: item.id, responseIndex: index, outcome, exitCode: response.exitCode ?? null,
        diagnosticCodes: (response.diagnostics ?? []).map(diagnostic => diagnostic.causeCode ?? diagnostic.code),
        issueCodes: (response.diagnostics ?? []).flatMap(diagnostic => (diagnostic.issues ?? []).map(issue => issue.code))});
    }
    for (let missing = responses.length; missing < Math.max(calls.length, 1) - helps; missing++) {
      attempts.push({itemId: item.id, outcome: 'unknown', exitCode: item.exit_code ?? null, diagnosticCodes: [], issueCodes: []});
    }
  }
  const complete = completed && attempts.every(attempt => attempt.outcome !== 'unknown');
  let pending = false, retries = 0;
  for (const attempt of attempts) {
    if (pending) retries++;
    pending = attempt.outcome !== 'saved';
  }
  return {complete, attempts: attempts.length, successfulWrites: attempts.filter(attempt => attempt.outcome === 'saved').length,
    failedAttempts: attempts.filter(attempt => attempt.outcome === 'rejected').length,
    retries: complete ? retries : null, unrecoveredFailure: complete ? pending : null, helpCalls, evidence: attempts};
}

function checkActivity(events, completed) {
  const reports = [];
  let unknownCalls = 0;
  for (const event of events) {
    const item = event.item;
    if (event.type !== 'item.completed' || item?.type !== 'command_execution') continue;
    const command = (item.command ?? '').replace(/['"]/g, '');
    if (!/\bnode(?:\.exe)?\b/.test(command)) continue;
    const responses = jsonObjects(item.aggregated_output ?? '').filter(value => value.schemaVersion === 1
      && value.command === 'check' && value.outputKind === 'result');
    const calls = [...command.matchAll(/\bcheck\s+--/g)];
    const expected = calls.filter((call, index) => {
      const part = command.slice(call.index, calls[index + 1]?.index);
      return /--run\b/.test(part) && !/--(?:help|version)\b/.test(part);
    }).length;
    unknownCalls += Math.max(0, expected - responses.length);
    for (const [responseIndex, response] of responses.entries()) reports.push({itemId: item.id, responseIndex,
      baselineHash: response.baselineHash ?? null, snapshotHash: response.snapshotHash ?? null, status: response.status,
      verification: (response.verification ?? []).map(item => item.status), errors: (response.errors ?? []).length,
      findings: (response.findings ?? []).map(({rule, severity, locations, similarity}) => ({rule, severity, locations, ...(similarity ? {similarity} : {})}))});
  }
  return {complete: completed && unknownCalls === 0, unknownCalls, reports};
}

// An observed warning -> later clean check is sequence evidence, not a causal claim.
// Parent analysis and patch review remain separate from the agent's own reports.
export function correctionEvidence(activity, {baselineHash, startingHash, finalHash, targetRules, seeded, finalClean, verificationCount, draftHash}) {
  const reports = activity?.reports ?? [];
  const verified = report => report.baselineHash === baselineHash && report.status !== 'incomplete' && report.errors === 0
    && report.verification.length === verificationCount && verificationCount > 0 && report.verification.every(status => status === 'passed');
  const first = reports.findIndex(report => verified(report) && report.findings.some(item => targetRules.includes(item.rule)));
  const last = reports.findLastIndex(report => verified(report) && report.status === 'pass' && report.snapshotHash === finalHash
    && !report.findings.some(item => targetRules.includes(item.rule)));
  const checkpoint = !seeded || first >= 0 && reports[first].snapshotHash === startingHash;
  const draftOpportunity = draftHash === undefined || first === 0 && reports[first].snapshotHash === draftHash;
  const reference = index => index < 0 ? null : {itemId: reports[index].itemId, responseIndex: reports[index].responseIndex, snapshotHash: reports[index].snapshotHash};
  return {targetRules, warningObserved: first >= 0, seededCheckpoint: seeded ? checkpoint : null,
    observedCorrection: !!activity?.complete && checkpoint && draftOpportunity && first >= 0 && last > first
      && startingHash !== finalHash && reports[first].snapshotHash !== finalHash && finalClean,
    warning: reference(first), finalCheck: reference(last)};
}

export function pairedSummary(results) {
  const pairIds = [...new Set(results.map(result => JSON.stringify([result.taskId ?? null, result.repetition])))];
  return pairIds.map(key => {
    const [taskId, repetition] = JSON.parse(key);
    const identity = { ...(taskId ? {taskId} : {}), repetition };
    const inPair = result => (result.taskId ?? null) === taskId && result.repetition === repetition;
    const control = results.find(result => inPair(result) && result.arm === 'control');
    const terse = results.find(result => inPair(result) && result.arm === 'terse');
    if (!control || !terse) return { ...identity, comparable: false, reason: 'Missing arm' };
    const comparable = control.protocolValid && terse.protocolValid && control.baselineHash === terse.baselineHash
      && control.startingHash === terse.startingHash
      && typeof control.acceptanceHash === 'string' && control.acceptanceHash === terse.acceptanceHash
      && [control, terse].every(run => Number.isFinite(run.agentMs) && run.agentMs >= 0 && Number.isInteger(run.newDuplications) && run.newDuplications >= 0);
    return { ...identity, comparable,
      correctness: { control: control.correct, terse: terse.correct },
      duplicateGroups: { control: control.newDuplications, terse: terse.newDuplications },
      agentMs: { control: control.agentMs, terse: terse.agentMs },
      terseMinusControlMs: comparable ? terse.agentMs - control.agentMs : null };
  });
}
