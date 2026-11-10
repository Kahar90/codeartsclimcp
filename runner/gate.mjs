// Bounded, ordered parallel execution for the gate CHECK lines. The runner defaults to one line at a
// time because checks may depend on each other's side effects; a lane opts into concurrency with the
// CHECK_PARALLEL env var. Every item runs, results come back in the original order, and each carries
// its own start time so the caller can report in CHECK order and pick the earliest failing line.
export async function runOrdered(items, worker, { concurrency = 1 } = {}) {
  const results = new Array(items.length);
  const runOne = async (i) => {
    const started = Date.now();
    let value = null; let error = null;
    try { value = await worker(items[i], i); } catch (e) { error = e; }
    results[i] = { index: i, started, ended: Date.now(), value, error };
  };
  const width = Math.max(1, Math.min(Math.floor(Number(concurrency) || 1), items.length || 1));
  if (width <= 1) {
    for (let i = 0; i < items.length; i++) await runOne(i);
  } else {
    let next = 0;
    const slots = Array.from({ length: width }, async () => { for (;;) { const i = next++; if (i >= items.length) return; await runOne(i); } });
    await Promise.all(slots);
  }
  return results;
}
