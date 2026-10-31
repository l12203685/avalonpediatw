import type { OutcomeTally, StrengthReport } from '@avalon/shared/stats';
import { StatTable, type StatColumn } from '../ui';

/** S 分層（高強度 ≥65／偏強 55–65／一般 38–55／偏弱 <38／全部）的局數與結果比率。 */

interface Row extends OutcomeTally {
  id: string;
  label: string;
  range: string;
}

const pct = (num: number, den: number): number | null => (den > 0 ? (100 * num) / den : null);

export default function StrengthTiers({ report }: { report: StrengthReport }): JSX.Element {
  const rows: Row[] = [...report.tiers, { id: 'all', label: '全部', range: '有陣容強度的局', ...report.overall }];
  const columns: StatColumn<Row>[] = [
    { key: 'label', label: '分層', format: (_, r) => <span title={r.range}><b>{r.label}</b> <span className="text-zinc-500">{r.range}</span></span> },
    { key: 'n', label: '局數', format: 'int' },
    { key: 'threeRed', label: '三紅', format: 'pct', value: (r) => pct(r.threeRed, r.n), tone: 'red', title: '三紅的局 ÷ 這層的局', lowSample: 20, n: 'n' },
    { key: 'blueDead', label: '三藍被刀', format: 'pct', value: (r) => pct(r.blueDead, r.n), tone: 'amber', title: '三藍但梅林被刺中的局 ÷ 這層的局', lowSample: 20, n: 'n' },
    { key: 'blueAlive', label: '三藍躲刺', format: 'pct', value: (r) => pct(r.blueAlive, r.n), tone: 'blue', title: '三藍而且梅林沒被刺中的局 ÷ 這層的局', lowSample: 20, n: 'n' },
    {
      key: 'hit', label: '刺中率', format: 'pct', value: (r) => pct(r.blueDead, r.blueDead + r.blueAlive), tone: 'amber',
      title: '三藍的局裡，刺客刺中梅林的比例', n: (r) => r.blueDead + r.blueAlive, lowSample: 20,
    },
  ];
  return (
    <div data-testid="strength-tiers">
      <StatTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        highlightRow={(r) => r.id === 'all'}
        caption="依 S 分層的結果"
        footnote="S = 桌上 10 人開打前 PR 的平均；PR 是在「生涯已 ≥30 場」的玩家池裡排的百分等級，暫定玩家最高算 50。不到 20 局的格子變淡。"
      />
    </div>
  );
}
