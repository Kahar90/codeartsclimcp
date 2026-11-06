// Progress watchdog for long "thinking" turns: a builder that streams reasoning for many
// minutes without a tool call or answer text is stalled in practice, even though deltas keep
// arriving and reset the silence watchdog. Pure functions only: no imports, no I/O.
export function progressAge({ turnStartAt, lastToolAt, lastTextAt, now }) {
  const latest = Math.max(turnStartAt || 0, lastToolAt || 0, lastTextAt || 0);
  return Math.max(0, (now || 0) - latest);
}

// stall is true only when the session is busy, no tool is running, the watchdog is on
// (thinkS > 0) and there has been no progress for over thinkS seconds. nudge is the resume
// prompt for the aborted turn.
export function thinkStall({ busy, toolsRunning, turnStartAt, lastToolAt, lastTextAt, now, thinkS }) {
  const ageMs = progressAge({ turnStartAt, lastToolAt, lastTextAt, now });
  const stall = !!busy && !toolsRunning && (thinkS || 0) > 0 && ageMs > thinkS * 1000;
  const mins = Math.max(1, Math.round(ageMs / 60000));
  const nudge = `Watchdog: you spent about ${mins} minutes reasoning without a tool call. Stop planning and get back to work: make the next edit now, then run this step's check and commit.`;
  return { stall, ageMs, nudge };
}
