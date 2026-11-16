/**
 * 被證明的紅（站長 2026-11-16 裁定，Issue #17）：
 *
 * > 第4局被湖證明的莫德雷德也不要派 應該說 任何已經被湖中女神+任務證明的壞人 都不該派
 *
 * A blue seat (Merlin, Percival, loyal) never puts on its team a player its OWN certainty layer (`belief/Certainty.ts`, level L1*)
 * proves red from the lake declarations and mission results, together with the seat's own legal view: Merlin's sight, Percival's
 * thumbs (his private information), the seat's own private lake results — nothing else.
 *
 * - Merlin's sight-only reds (a thumb he sees that no lake / mission proves) keep their own rules (R1–R2 cover, reuse, …). A seen red
 *   counts as proven only when the public record proves it too (the public loyal of Merlin's seat finds it certainly red). A red Merlin
 *   cannot see but proves by lake + sight (the Issue #17 case: a holder declared a red he sees as good → that holder is Mordred) is
 *   proven.
 * - L1* falls back to L0 when the lake declarations leave no consistent world (a good human lied): no hard exclusion from the lakes then,
 *   only what the missions and the seat's own view prove.
 */
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { certaintyFor } from './LogicGates';
import type { PlayerObservation } from './types';

/** Diagnostics for the smoke runs (never read by the agents). */
export const provenRedStats = { teams: 0, fired: 0, fallback: 0, reuseRefill: 0 };

/** The public loyal view of Merlin's seat: the same record and his own lakes, none of his sight. */
function merlinPublicView(obs: PlayerObservation): PlayerObservation {
  return { ...obs, myRole: 'loyal', knownEvils: [], knownWizards: undefined } as PlayerObservation;
}

/** The seats this blue seat's own certainty proves red from lakes + missions (+ its legal view); empty for a red seat. */
export function provenReds(obs: PlayerObservation): string[] {
  const camp = obs.seatTeam ?? obs.myTeam;
  if (camp !== 'good') return [];
  const me = obs.myPlayerId;
  const red = certaintyFor(obs).certRed('L1*').filter((id) => id !== me);
  if (obs.myRole !== 'merlin') return red;
  const seen = new Set(obs.knownEvils);
  const publicRed = seen.size > 0 && red.some((id) => seen.has(id)) ? new Set(certaintyFor(merlinPublicView(obs)).certRed('L1*')) : new Set<string>();
  return red.filter((id) => !seen.has(id) || publicRed.has(id));
}

/** The seats `goodProvenRedBar` keeps off this seat's team (empty when the knob is off or the seat is red). */
export function provenRedBar(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation): string[] {
  return tuning.goodProvenRedBar ? provenReds(obs) : [];
}

/**
 * A re-proposal of `team` without the proven reds (`proven`): the rest stays, the open seats take the cleanest seats of this seat's own
 * posterior (equal shares in a random order — never seat order, 11/10 ruling) that are not proven red nor a red the seat sees, the first
 * fill `allowed` accepts. Null when none does.
 */
export function refillWithoutProven(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  team: readonly string[],
  proven: readonly string[],
  allowed: (team: readonly string[]) => boolean,
): string[] | null {
  const kept = team.filter((id) => !proven.includes(id));
  const need = team.length - kept.length;
  if (need === 0) return allowed(kept) ? kept : null;
  const share = bayesRedShare(obs, bayesOptionsOf(tuning));
  const tie = new Map(obs.allPlayerIds.map((id) => [id, Math.random()] as const));
  const pool = obs.allPlayerIds
    .filter((id) => !kept.includes(id) && !proven.includes(id) && !obs.knownEvils.includes(id))
    .sort((x, y) => (share.get(x) ?? 0.5) - (share.get(y) ?? 0.5) || tie.get(x)! - tie.get(y)!);
  const out: string[][] = [];
  const rec = (start: number, acc: string[]): void => {
    if (out.length >= 4000) return;
    if (acc.length === need) { out.push([...acc]); return; }
    for (let i = start; i < pool.length; i++) { acc.push(pool[i]); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  out.sort((a, b) => Math.max(...a.map((x) => pool.indexOf(x))) - Math.max(...b.map((x) => pool.indexOf(x))));
  for (const fill of out) {
    const t = [...kept, ...fill];
    if (allowed(t)) return t;
  }
  return null;
}
