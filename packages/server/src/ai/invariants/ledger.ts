/**
 * Invariant ledger: per-rule tallies (opportunities, exemptions by reason,
 * bot violations, violations on unreliable replay input, the human's own
 * decisions on the same replay states) and free-form diagnostic counters
 * that reproduce the logic audit's numbers. Aggregates only — no game ids,
 * no names, no seat-to-person mapping.
 */

import { INVARIANTS } from './catalog';

export interface Tally {
  opportunities: number;
  exempt: Record<string, number>;
  violations: number;
  /** Violations on replay decision points whose vote record was reconstructed. */
  unreliable: number;
  humanOpportunities: number;
  humanViolations: number;
}

export interface Outcome {
  /** Registered exemption (counted, never a violation). */
  exempt?: string;
  violated?: boolean;
  /** The decision point's input is unreliable (replay reconstruction). */
  unreliable?: boolean;
}

function emptyTally(): Tally {
  return { opportunities: 0, exempt: {}, violations: 0, unreliable: 0, humanOpportunities: 0, humanViolations: 0 };
}

export class Ledger {
  readonly tallies = new Map<string, Tally>();
  readonly diag = new Map<string, number>();

  constructor() {
    for (const spec of INVARIANTS) this.tallies.set(spec.id, emptyTally());
  }

  private tally(id: string): Tally {
    let t = this.tallies.get(id);
    if (!t) { t = emptyTally(); this.tallies.set(id, t); }
    return t;
  }

  record(id: string, o: Outcome): void {
    const t = this.tally(id);
    t.opportunities++;
    if (o.exempt) {
      t.exempt[o.exempt] = (t.exempt[o.exempt] ?? 0) + 1;
      return;
    }
    if (o.violated) {
      t.violations++;
      if (o.unreliable) t.unreliable++;
    }
  }

  human(id: string, violated: boolean): void {
    const t = this.tally(id);
    t.humanOpportunities++;
    if (violated) t.humanViolations++;
  }

  inc(key: string, by = 1): void {
    this.diag.set(key, (this.diag.get(key) ?? 0) + by);
  }

  get(key: string): number {
    return this.diag.get(key) ?? 0;
  }

  merge(other: Ledger): void {
    for (const [id, o] of other.tallies) {
      const t = this.tally(id);
      t.opportunities += o.opportunities;
      t.violations += o.violations;
      t.unreliable += o.unreliable;
      t.humanOpportunities += o.humanOpportunities;
      t.humanViolations += o.humanViolations;
      for (const [k, v] of Object.entries(o.exempt)) t.exempt[k] = (t.exempt[k] ?? 0) + v;
    }
    for (const [k, v] of other.diag) this.inc(k, v);
  }

  toJSON(): { tallies: Record<string, Tally>; diag: Record<string, number> } {
    const tallies: Record<string, Tally> = {};
    for (const [id, t] of this.tallies) tallies[id] = t;
    const diag: Record<string, number> = {};
    for (const k of [...this.diag.keys()].sort()) diag[k] = this.diag.get(k) ?? 0;
    return { tallies, diag };
  }

  /** One row per invariant, in catalog order. */
  formatTable(title: string, withHuman: boolean): string {
    const rows: string[] = [];
    rows.push(`## ${title}`);
    const head = ['rule', 'kind', 'status', 'opportunities', 'exempt (reason: n)', 'bot violations', 'of them on unreliable input'];
    if (withHuman) head.push('human violations / human opportunities');
    rows.push(`| ${head.join(' | ')} |`);
    rows.push(`|${head.map(() => '---').join('|')}|`);
    for (const spec of INVARIANTS) {
      const t = this.tallies.get(spec.id) ?? emptyTally();
      const exempt = Object.entries(t.exempt).map(([k, v]) => `${k}: ${v}`).join('; ') || '0';
      const cells = [spec.id, spec.kind, spec.status, String(t.opportunities), exempt, String(t.violations), String(t.unreliable)];
      if (withHuman) cells.push(t.humanOpportunities > 0 ? `${t.humanViolations} / ${t.humanOpportunities}` : '—');
      rows.push(`| ${cells.join(' | ')} |`);
    }
    return rows.join('\n');
  }
}
