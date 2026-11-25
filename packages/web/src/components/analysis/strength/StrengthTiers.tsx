import { useTranslation } from 'react-i18next';
import type { OutcomeTally, StrengthReport } from '@avalon/shared/stats';
import { Advanced, GlanceLegend, GlanceRow, SplitBar, StatTable, Takeaway, type StatColumn } from '../ui';
import { pctText, strengthTiersGlance } from '../core/glance';
import { sampleText, sentenceText } from '../core/glanceView';

/**
 * S 分層（高強度 ≥65／偏強 55–65／一般 38–55／偏弱 <38／全部）的局數與結果比率。
 * (2026-11-25 站長「一目瞭然」，第四批) 最上面一句話（藍方贏最多、最少的分層），每一層一條三段長條
 * （三個任務失敗｜梅林被刺中｜藍方贏，佔這層的局；顏色同全站三種結局），原本的表格（含刺中率）收進「進階」。
 */

interface Row extends OutcomeTally {
  id: string;
  label: string;
  range: string;
}

/** 不到這麼多局的分層：表格變淡、句子不拿來比（同原本表格的 lowSample）。 */
const MIN_TIER_GAMES = 20;

const pct = (num: number, den: number): number | null => (den > 0 ? (100 * num) / den : null);

export default function StrengthTiers({ report }: { report: StrengthReport }): JSX.Element {
  const { t } = useTranslation('common');
  const rows: Row[] = [...report.tiers, { id: 'all', label: '全部', range: '有陣容強度的局', ...report.overall }];
  const glance = strengthTiersGlance(report.tiers, MIN_TIER_GAMES);
  const lead = sentenceText(t, glance.sentence);
  const columns: StatColumn<Row>[] = [
    { key: 'label', label: '分層', format: (_, r) => <span title={r.range}><b>{r.label}</b> <span className="text-zinc-500">{r.range}</span></span> },
    { key: 'n', label: '局數', format: 'int' },
    { key: 'threeRed', label: '三個任務失敗', format: 'pct', value: (r) => pct(r.threeRed, r.n), tone: 'red', title: '三個任務失敗（紅方直接贏）的局 ÷ 這層的局', lowSample: MIN_TIER_GAMES, n: 'n' },
    { key: 'blueDead', label: '梅林被刺中', format: 'pct', value: (r) => pct(r.blueDead, r.n), tone: 'kill', title: '藍方做完三個任務、但梅林被刺中的局 ÷ 這層的局', lowSample: MIN_TIER_GAMES, n: 'n' },
    { key: 'blueAlive', label: '藍方贏', format: 'pct', value: (r) => pct(r.blueAlive, r.n), tone: 'blue', title: '藍方做完三個任務、梅林也沒被刺中的局 ÷ 這層的局', lowSample: MIN_TIER_GAMES, n: 'n' },
    {
      key: 'hit', label: '刺中率', format: 'pct', value: (r) => pct(r.blueDead, r.blueDead + r.blueAlive), tone: 'kill',
      title: '藍方做完三個任務的局裡，刺客刺中梅林的比例', n: (r) => r.blueDead + r.blueAlive, lowSample: MIN_TIER_GAMES,
    },
  ];
  const bars = rows.filter((r) => r.n > 0);
  return (
    <div className="space-y-3" data-testid="strength-tiers">
      <Takeaway>
        {lead && <p className="text-sm font-semibold text-white sm:text-[15px]" data-testid="strength-tiers-lead">{lead}</p>}
        <p className="text-zinc-400">{sentenceText(t, { key: 'strength.sDef', params: {} })}</p>
      </Takeaway>
      <section className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
        <h4 className="text-xs font-bold text-zinc-300">桌上實力不同時，三種結局各佔多少</h4>
        <GlanceLegend items={[{ name: '三個任務失敗', tone: 'red' }, { name: '梅林被刺中', tone: 'kill' }, { name: '藍方贏', tone: 'blue' }]} />
        {bars.map((r) => {
          // 三段各自照原本表格的寫法進位（數字跟「進階」的表一樣；加起來可能差 1%）
          const [red, dead, alive] = [r.threeRed, r.blueDead, r.blueAlive].map((k) => (100 * k) / r.n);
          return (
            <GlanceRow
              key={r.id}
              label={<>{r.label} <span className="font-normal text-zinc-500">{r.range}</span></>}
              sample={sampleText(t, r.n)}
              thin={r.n < MIN_TIER_GAMES ? t('analytics.glance.thin') : undefined}
            >
              <SplitBar
                sample={sampleText(t, r.n)}
                segments={[
                  { pct: red, text: pctText(red), name: '三個任務失敗', tone: 'red' },
                  { pct: dead, text: pctText(dead), name: '梅林被刺中', tone: 'kill' },
                  { pct: alive, text: pctText(alive), name: '藍方贏', tone: 'blue' },
                ]}
              />
            </GlanceRow>
          );
        })}
      </section>
      <Advanced title="進階：分層的完整表格（含刺中率）" testId="strength-tiers-advanced">
        {() => (
          <StatTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            highlightRow={(r) => r.id === 'all'}
            caption="依 S 分層的結果"
            footnote="S = 桌上 10 人開打前 PR 的平均；PR 是在「生涯已 ≥30 場」的玩家池裡排的百分等級，暫定玩家最高算 50。不到 20 局的格子變淡。"
          />
        )}
      </Advanced>
    </div>
  );
}
