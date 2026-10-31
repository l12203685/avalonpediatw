import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { METRICS, type Clause, type MetricId } from '@avalon/shared/stats';
import { useRoleLabel } from '../roleLabels';
import { OUTCOME_LABEL_KEYS, type OutcomeKey } from '../ui';

/**
 * 篩選條件的文字 (面板上的條件標籤)：每種子句一句話，中英文。名字、日期原樣顯示。
 */
export function useMetricLabel(): (id: MetricId) => string {
  const { i18n } = useTranslation('common');
  const en = (i18n.language ?? '').startsWith('en');
  return useCallback((id: MetricId) => (en ? METRICS[id].labelEn : METRICS[id].label), [en]);
}

export function useClauseLabel(): (clause: Clause) => string {
  const { t, i18n } = useTranslation('common');
  const en = (i18n.language ?? '').startsWith('en');
  const role = useRoleLabel();
  const metric = useMetricLabel();
  return useCallback((clause: Clause): string => {
    const k = 'analytics.filter.clause';
    const join = (xs: ReadonlyArray<string | number>): string => xs.join('、');
    const side = (s: string): string => t(`analytics.filter.sideValues.${s}`);
    const range = (min?: number, max?: number): { min: string; max: string } => ({
      min: min === undefined ? '…' : String(min), max: max === undefined ? '…' : String(max),
    });
    const outcome = (o: string): string => (o in OUTCOME_LABEL_KEYS ? t(OUTCOME_LABEL_KEYS[o as OutcomeKey]) : o);
    const text = ((): string => {
      switch (clause.kind) {
        case 'category':
          return t(`${k}.category`, { values: join(clause.in.map((c) => t(`analytics.filter.categories.${c}`))) });
        case 'source':
          return t(`${k}.source`, { values: join(clause.in.map((s) => t(`analytics.filter.sources.${s}`))) });
        case 'date':
          return t(`${k}.date`, { from: clause.from ?? '…', to: clause.to ?? '…' })
            + (clause.undated === 'include' ? t(`${k}.dateUndated`) : '');
        case 'weekday':
          return t(`${k}.weekday`, { values: join(clause.in.map((d) => t(`analytics.filter.weekdays.${d}`))) });
        case 'sessionIndex':
          return t(`${k}.sessionIndex`, range(clause.min, clause.max));
        case 'season':
          return t(`${k}.season`, { values: join(clause.in) });
        case 'venue':
          return t(`${k}.venue`, { values: join(clause.in) });
        case 'noteFlag':
          return t(`${k}.noteFlag`, { values: join(clause.any) });
        case 'namedSeats':
          return t(`${k}.namedSeats`, range(clause.min, clause.max));
        case 'outcome':
          return t(`${k}.outcome`, { values: join(clause.in.map(outcome)) });
        case 'finalWinner':
          return t(`${k}.finalWinner`, { side: side(clause.is) });
        case 'missionCount':
          return t(`${k}.missionCount`, { values: join(clause.in) });
        case 'mission': {
          let detail = clause.result ? t(clause.result === 'pass' ? `${k}.missionPass` : `${k}.missionFail`) : '';
          if (clause.minFails !== undefined || clause.maxFails !== undefined) detail += t(`${k}.missionFails`, range(clause.minFails, clause.maxFails));
          return t(`${k}.mission`, { round: clause.round, detail });
        }
        case 'gameState':
          return t(`${k}.gameState`, { values: join(clause.in) });
        case 'firstTeam': {
          const parts: string[] = [];
          if (clause.redCount) parts.push(`${join(clause.redCount)}${t('analytics.filter.sideValues.red')}`);
          if (clause.hasMerlin !== undefined) parts.push(`${clause.hasMerlin ? '+' : '−'}${role('梅林')}`);
          if (clause.hasPercival !== undefined) parts.push(`${clause.hasPercival ? '+' : '−'}${role('派西維爾')}`);
          return t(`${k}.firstTeam`, { detail: parts.length ? ` ${parts.join(' ')}` : '' });
        }
        case 'lakeCount':
          return t(`${k}.lakeCount`, { values: join(clause.in) });
        case 'lake': {
          const parts: string[] = [];
          if (clause.holderSide) parts.push(`${side(clause.holderSide)}→`);
          if (clause.holderRole) parts.push(`${join(clause.holderRole.map(role))}→`);
          if (clause.targetSide) parts.push(side(clause.targetSide));
          if (clause.targetRole) parts.push(join(clause.targetRole.map(role)));
          if (clause.claim) parts.push(`(${join(clause.claim)})`);
          return t(`${k}.lake`, { index: clause.index, detail: parts.length ? ` ${parts.join(' ')}` : '' });
        }
        case 'assassination':
          return t(`${k}.assassination`, { values: join(clause.target.map((r) => (r === 'none' ? '—' : role(r)))) });
        case 'roleSeat':
          return t(`${k}.roleSeat`, { role: role(clause.role), seats: join(clause.seats) });
        case 'trioOrder':
          return t(`${k}.trioOrder`, { values: join(clause.in) });
        case 'captain':
          return t(`${k}.captain`, { round: clause.round, side: side(clause.side) });
        case 'gameId':
          return t(`${k}.gameId`, { count: clause.in.length });
        case 'lineup': {
          const parts: string[] = [];
          if (clause.sMin !== undefined) parts.push(`S ≥ ${clause.sMin}`);
          if (clause.strongPr !== undefined && clause.strongCount !== undefined) parts.push(`PR ${clause.strongPr}+ ≥ ${clause.strongCount}`);
          if (clause.merlinPrMin !== undefined) parts.push(`${en ? 'Merlin' : '梅林'} PR ≥ ${clause.merlinPrMin}`);
          if (clause.percivalPrMin !== undefined) parts.push(`${en ? 'Percival' : '派西'} PR ≥ ${clause.percivalPrMin}`);
          if (clause.redMinPrMin !== undefined) parts.push(`${en ? 'weakest red' : '紅方最低'} PR ≥ ${clause.redMinPrMin}`);
          if (clause.loyalMinPrMin !== undefined) parts.push(`${en ? 'weakest loyal' : '忠臣最低'} PR ≥ ${clause.loyalMinPrMin}`);
          if (clause.gapMin !== undefined) parts.push(`${en ? 'red − blue mean PR' : '紅−藍平均 PR'} ≥ ${clause.gapMin}`);
          const glue = clause.combine === 'or' ? (en ? ' or ' : ' 或 ') : (en ? ' and ' : ' 且 ');
          return t(`${k}.lineup`, { detail: parts.join(glue) + (clause.includeUnscored ? (en ? ' (+ unscored)' : '（含未評分）') : '') });
        }
        case 'withPlayer': {
          const parts: string[] = [];
          if (clause.role) parts.push(join(clause.role.map(role)));
          if (clause.side) parts.push(side(clause.side));
          if (clause.seat) parts.push(`#${join(clause.seat)}`);
          if (clause.result) parts.push(t(`analytics.filter.fields.${clause.result}`));
          return t(`${k}.withPlayer`, { player: clause.player, detail: parts.length ? `（${parts.join('，')}）` : '' });
        }
        case 'withAnyPlayer':
          return t(`${k}.withAnyPlayer`, { values: join(clause.players) });
        case 'withPlayers':
          return t(`${k}.withPlayers`, { a: clause.players[0], b: clause.players[1], relation: t(`${k}.${clause.relation}`) });
        case 'excludePlayers': {
          const scope = t(clause.scope === 'dropGames' ? `${k}.scopeDrop` : `${k}.scopeHide`);
          const who = clause.who;
          if (who.by === 'names') {
            return t(who.invert ? `${k}.excludeExcept` : `${k}.excludeNames`, { names: join(who.names), scope });
          }
          const threshold = typeof who.pr === 'number' ? t(`${k}.prThreshold`, { value: who.pr }) : String(who.value);
          return t(`${k}.excludeMetric`, {
            metric: metric(who.metric),
            role: who.role ? `（${role(who.role)}）` : '',
            op: t(`analytics.filter.ops.${who.op}`),
            threshold,
            scope,
          }) + (who.evaluatedOn === 'filtered' ? t(`${k}.filteredSuffix`) : '');
        }
        default:
          return t(`${k}.unknown`, { kind: (clause as { kind: string }).kind });
      }
    })();
    return 'not' in clause && clause.not ? t(`${k}.not`, { text }) : text;
  }, [t, role, metric, en]);
}
