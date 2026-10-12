/**
 * Aggregation + formatting for the agreement benchmark (2026-10-10).
 *
 * Each `DecisionOutcome` is counted into every cohort it belongs to
 * (population, named players, per-role top performers) under a set of
 * metric keys `${type}/${slice}`, e.g. `vote/R3+`, `team/R2+ role=merlin`.
 */

import type { DecisionOutcome } from './agreement';

/** Locale-independent string order (deterministic output). */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface Tally {
  n: number;
  /** Σ agent agreement. */
  agent: number;
  /** Σ default-baseline agreement. */
  dflt: number;
  /** Σ rule-baseline agreement. */
  rule: number;
  /** Team only: Σ Jaccard for agent / default / rule. */
  jac: number;
  dJac: number;
  rJac: number;
  /** Vote only: human / agent anomaly counts. */
  hAnom: number;
  aAnom: number;
  /** Assassinate only: human / agent Merlin hits. */
  hHit: number;
  aHit: number;
}

export interface SituationTally {
  /** Decisions in this situation. */
  n: number;
  /** ... where the agent disagreed with the human. */
  mismatches: number;
  /** Divergence label → count. */
  divergences: Record<string, number>;
}

export interface CohortReport {
  label: string;
  decisions: number;
  metrics: Record<string, Tally>;
  /** Situation (context) → counts, all roles. */
  situations: Record<string, SituationTally>;
  /** `${role} | ${situation}` → counts. */
  roleSituations: Record<string, SituationTally>;
}

export function emptyCohort(label: string): CohortReport {
  return { label, decisions: 0, metrics: {}, situations: {}, roleSituations: {} };
}

function bump(report: CohortReport, key: string, o: DecisionOutcome): void {
  const t = report.metrics[key] ?? (report.metrics[key] = {
    n: 0, agent: 0, dflt: 0, rule: 0, jac: 0, dJac: 0, rJac: 0, hAnom: 0, aAnom: 0, hHit: 0, aHit: 0,
  });
  t.n += 1;
  t.agent += o.match ? 1 : 0;
  t.dflt += o.defaultMatch;
  t.rule += o.ruleMatch;
  t.jac += o.jaccard ?? 0;
  t.dJac += o.defaultJaccard ?? 0;
  t.rJac += o.ruleJaccard ?? 0;
  t.hAnom += o.humanNonDefault ? 1 : 0;
  t.aAnom += o.agentNonDefault ? 1 : 0;
  t.hHit += o.humanHitMerlin ? 1 : 0;
  t.aHit += o.agentHitMerlin ? 1 : 0;
}

function roundSlice(round: number): string {
  return round === 1 ? 'R1' : round === 2 ? 'R2' : 'R3+';
}

/** Metric keys a decision contributes to. */
export function metricKeys(o: DecisionOutcome): string[] {
  const t = o.type;
  const keys = [`${t}/all`, `${t}/side=${o.side}`, `${t}/role=${o.role}`];
  switch (t) {
    case 'team': {
      const r = o.round === 1 ? 'R1' : 'R2+';
      keys.push(`team/${r}`, `team/${r} side=${o.side}`, `team/${r} role=${o.role}`);
      break;
    }
    case 'vote': {
      const r = roundSlice(o.round);
      keys.push(`vote/${r}`, `vote/${r} side=${o.side}`, `vote/${r} role=${o.role}`);
      if (o.round >= 2) keys.push('vote/R2+', `vote/R2+ role=${o.role}`);
      if (o.humanNonDefault) {
        keys.push('vote/human-anomaly', `vote/human-anomaly ${r}`, `vote/human-anomaly role=${o.role}`);
      }
      if (o.agentNonDefault) keys.push('vote/agent-anomaly', `vote/agent-anomaly ${r}`);
      break;
    }
    case 'quest':
      keys.push(`quest/R${o.round}`);
      break;
    default:
      break;
  }
  return keys;
}

function bumpSituation(table: Record<string, SituationTally>, key: string, o: DecisionOutcome): void {
  const s = table[key] ?? (table[key] = { n: 0, mismatches: 0, divergences: {} });
  s.n += 1;
  if (o.match) return;
  s.mismatches += 1;
  s.divergences[o.divergence] = (s.divergences[o.divergence] ?? 0) + 1;
}

export function addOutcome(report: CohortReport, o: DecisionOutcome): void {
  report.decisions += 1;
  for (const key of metricKeys(o)) bump(report, key, o);
  bumpSituation(report.situations, o.situation, o);
  bumpSituation(report.roleSituations, `${o.role} | ${o.situation}`, o);
}

export function pct(num: number, den: number): string {
  return den === 0 ? '—' : `${((num / den) * 100).toFixed(1)}%`;
}

export interface Divergence {
  situation: string;
  divergence: string;
  /** Decisions that diverged this way. */
  count: number;
  /** Decisions in the situation (any outcome). */
  situationN: number;
}

/** Most frequent (situation, divergence) pairs. */
export function topDivergences(
  table: Record<string, SituationTally>,
  limit: number,
  filter: (situation: string) => boolean = () => true,
): Divergence[] {
  const out: Divergence[] = [];
  for (const [situation, t] of Object.entries(table)) {
    if (!filter(situation)) continue;
    for (const [divergence, count] of Object.entries(t.divergences)) {
      out.push({ situation, divergence, count, situationN: t.n });
    }
  }
  return out
    .sort((a, b) => b.count - a.count
      || cmpStr(a.situation, b.situation)
      || cmpStr(a.divergence, b.divergence))
    .slice(0, limit);
}

export function formatDivergence(d: Divergence): string {
  return `${String(d.count).padStart(6)} of ${String(d.situationN).padEnd(6)} ${d.situation}: ${d.divergence}`;
}

export interface TableRow {
  label: string;
  key: string;
  /** Use Jaccard instead of exact agreement. */
  jaccard?: boolean;
}

export const HEADLINE_ROWS: readonly TableRow[] = [
  { label: 'team exact R1', key: 'team/R1' },
  { label: 'team exact R2+', key: 'team/R2+' },
  { label: 'team Jaccard R2+', key: 'team/R2+', jaccard: true },
  { label: 'vote R1', key: 'vote/R1' },
  { label: 'vote R2', key: 'vote/R2' },
  { label: 'vote R3+', key: 'vote/R3+' },
  { label: 'vote: human anomaly', key: 'vote/human-anomaly' },
  { label: 'vote: human anomaly R3+', key: 'vote/human-anomaly R3+' },
  { label: 'quest card (pinned)', key: 'quest/all' },
  { label: 'lake target', key: 'lakeTarget/all' },
  { label: 'lake claim (evil)', key: 'lakeClaim/side=evil' },
  { label: 'assassinate', key: 'assassinate/all' },
];

/** "agent% (default% / rule%) n" for one cohort cell. */
export function cell(report: CohortReport, row: TableRow): string {
  const t = report.metrics[row.key];
  if (!t || t.n === 0) return '—';
  const [a, d, r] = row.jaccard ? [t.jac, t.dJac, t.rJac] : [t.agent, t.dflt, t.rule];
  return `${pct(a, t.n)} (${pct(d, t.n)}/${pct(r, t.n)}) n=${t.n}`;
}

export function formatTable(cohorts: readonly CohortReport[], rows: readonly TableRow[] = HEADLINE_ROWS): string {
  const header = ['decision', ...cohorts.map((c) => c.label)];
  const body = rows.map((row) => [row.label, ...cohorts.map((c) => cell(c, row))]);
  const extra = [
    'agent anomaly rate (R3+)',
    ...cohorts.map((c) => {
      const t = c.metrics['vote/R3+'];
      return t ? `${pct(t.aAnom, t.n)} vs human ${pct(t.hAnom, t.n)}` : '—';
    }),
  ];
  const hits = [
    'Merlin-hit rate',
    ...cohorts.map((c) => {
      const t = c.metrics['assassinate/all'];
      return t ? `agent ${pct(t.aHit, t.n)} vs human ${pct(t.hHit, t.n)}` : '—';
    }),
  ];
  const all = [header, ...body, extra, hits];
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n');
}
