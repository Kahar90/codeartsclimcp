// Foreground model budget for OPTIONAL early (step) reviews.
//
// A step review is an early warning, not the gate: the mandatory final review still covers the
// whole required range. When several lanes share one model (the common case is the flash builder
// and the flash step reviewer), an early step review that competes with a foreground builder for
// the same 1M TPM queue only makes the builders slower. This module decides, conservatively,
// whether a lane should postpone its optional step review so foreground builders keep the quota.
//
// Reserve a shared model only for a peer that is actually a foreground builder right now:
//   - alive              (a dead supervisor holds no model slot)
//   - unfinished         (result set -> the lane is done, its builders are gone)
//   - not queued         (activity "queued: ..." -> it holds no builder slot yet)
//   - in a build/fix phase  (a review-only or other phase does not consume build quota)
//   - on the same model  (different builders and a different step-review model never contend here)
// This lane's own builder (`selfId`) never blocks itself, so a single-lane run is unchanged.
//
// The decision is pure: callers supply fresh lane state and liveness so this file stays testable
// and never reads the registry itself.

// The peers that currently reserve `model` from this lane: the array is bounded by the caller's
// lane list and is exposed so a deferred review can publish a bounded, human-readable reason.
export function stepReviewBlockers({ model, selfId, lanes } = {}) {
  const wanted = String(model || '');
  if (!wanted || !Array.isArray(lanes)) return [];
  return lanes.filter((l) => {
    if (!l || typeof l !== 'object') return false;
    if (l.alive !== true) return false;                 // dead peer: no slot to reserve
    if (l.id === selfId) return false;                  // this lane's own builder never blocks itself
    const s = l.s;
    if (!s || typeof s !== 'object') return false;      // unreadable/missing state: never assume it reserves
    if (s.result) return false;                         // finished peer: its builders are gone
    if (/^queued/i.test(String(s.activity || ''))) return false; // queued: it holds no builder slot yet
    if (s.phase !== 'build' && s.phase !== 'fix') return false;  // review-only/other phase: no build quota
    return !!(s.models && s.models.build) && s.models.build === wanted;
  }).map((l) => ({ id: l.id, model: wanted, phase: l.s.phase }));
}

// True when an OPTIONAL early step review on `model` should wait for a foreground builder/fix
// phase that currently uses the same model. Conservative by construction: any doubt (missing
// liveness or state) reads as "do not reserve", so a lane alone keeps its immediate step review.
export function shouldDeferStepReview({ model, selfId, lanes } = {}) {
  return stepReviewBlockers({ model, selfId, lanes }).length > 0;
}
