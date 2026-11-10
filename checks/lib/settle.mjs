// Wait for every finite CSS animation and transition on the page to finish (looping sprite animations
// never end and are skipped). Measure geometry after this instead of after a fixed sleep: slow CI runners
// (macOS) were measuring windows mid-slide. Pass the check's Runtime.evaluate helper; it must await promises.
export const SETTLE_EXPR = `Promise.race([
  Promise.all(document.getAnimations()
    .filter((a) => { const t = a.effect && a.effect.getComputedTiming(); return t && Number.isFinite(t.endTime); })
    .map((a) => a.finished.catch(() => null))),
  new Promise((r) => setTimeout(r, 3000)),
]).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))`;

export async function settleAnims(evAwait) { return evAwait(SETTLE_EXPR); }
