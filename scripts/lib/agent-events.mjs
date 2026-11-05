// Keep protocol parsing separate from execution so CI never needs credentials or a live model.
export function summarizeEvents(text) {
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
  return { completed: completions.length > 0 && !failed && malformed === 0, malformed, usage,
    errors: events.filter(event => event.type === 'error' || event.item?.type === 'error').map(event => event.message ?? event.item.message),
    commandCount: events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution').length,
    finalMessage: events.filter(event => event.item?.type === 'agent_message').at(-1)?.item.text ?? null };
}

export function pairedSummary(results) {
  const pairIds = [...new Set(results.map(result => result.repetition))];
  return pairIds.map(repetition => {
    const control = results.find(result => result.repetition === repetition && result.arm === 'control');
    const terse = results.find(result => result.repetition === repetition && result.arm === 'terse');
    if (!control || !terse) return { repetition, comparable: false, reason: 'Missing arm' };
    const comparable = control.protocolValid && terse.protocolValid && control.baselineHash === terse.baselineHash
      && typeof control.acceptanceHash === 'string' && control.acceptanceHash === terse.acceptanceHash
      && [control, terse].every(run => Number.isFinite(run.agentMs) && run.agentMs >= 0 && Number.isInteger(run.newDuplications) && run.newDuplications >= 0);
    return { repetition, comparable,
      correctness: { control: control.correct, terse: terse.correct },
      duplicateGroups: { control: control.newDuplications, terse: terse.newDuplications },
      agentMs: { control: control.agentMs, terse: terse.agentMs },
      terseMinusControlMs: comparable ? terse.agentMs - control.agentMs : null };
  });
}
