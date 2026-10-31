import { Takeaway } from '../ui';
import { pct, ratioPct } from './NodeDetail';
import type { StateTreeFindings } from './stateTree';

function scoreText(score: string): string {
  const [b, r] = score.split(':');
  return `${b} 藍 ${r} 紅`;
}

/** 百分點差（0–1 → 「14 個百分點」）。 */
function points(x: number): string {
  return `${Math.round(Math.abs(x) * 100)} 個百分點`;
}

/**
 * 「看得出什麼」：句子裡的數字都是目前篩選下的局算的（stateTreeFindings），不寫死結論。
 * 同比分不同順序（最多三條）、第 2 局後第一次湖的宣告、第 2 局開藍後照派。
 */
export default function StateTreeSummary({ f }: { f: StateTreeFindings }): JSX.Element | null {
  if (!f.total) return null;
  const lake = f.lakeAfterR2;
  const reuse = f.reuseAfterR2Blue;
  const byBad = [...lake.bySeq].sort((a, b) => b.badShare - a.badShare);
  return (
    <Takeaway>
      <p className="font-semibold text-amber-200">看得出什麼</p>
      <p>
        這 {f.total} 局藍方最終勝率（三藍躲刺）{pct(f.baseline.blueWin)}、三紅 {pct(f.baseline.threeRed)}；
        節點顏色以全體為中點，偏藍＝對藍方比平常有利，偏紅＝對紅方有利。
      </p>
      {f.contrasts.slice(0, 3).map((c) => (
        <p key={c.score}>
          ・同樣 {scoreText(c.score)}，順序不同差很多：<b>{c.high.seq}</b>（{c.high.n} 局）藍方最終勝率 {pct(c.high.blueWin)}，
          <b>{c.low.seq}</b>（{c.low.n} 局）只有 {pct(c.low.blueWin)}；三紅 {pct(c.high.threeRed)} 對 {pct(c.low.threeRed)}。
        </p>
      ))}
      {lake.pooled && (
        <p>
          ・第 2 局後第一次湖：說好（{lake.pooled.good.n} 局）藍方最終勝率 {pct(lake.pooled.good.blueWin)}、
          說壞（{lake.pooled.bad.n} 局）{pct(lake.pooled.bad.blueWin)}，合併看差 {points((lake.pooled.good.blueWin ?? 0) - (lake.pooled.bad.blueWin ?? 0))}
          {lake.withinGap !== null && lake.bySeq.length >= 2 && (
            <>
              ；但同樣的前兩局裡比，平均只差 {points(lake.withinGap)}
              {byBad.length >= 2 && `（說壞在 ${byBad[0].seq} 之後最常見 ${pct(byBad[0].badShare)}，${byBad[byBad.length - 1].seq} 之後只有 ${pct(byBad[byBad.length - 1].badShare)}，合併的差距有一部分是前兩局本身造成的）`}
            </>
          )}
          。
          {lake.bySeq[0] && (
            <>
              差最多的是 {lake.bySeq[0].seq}：說好 {pct(lake.bySeq[0].good.blueWin)}（{lake.bySeq[0].good.n}）、
              說壞 {pct(lake.bySeq[0].bad.blueWin)}（{lake.bySeq[0].bad.n}）。
            </>
          )}
        </p>
      )}
      {reuse && reuse.reuse.of > 0 && (
        <p>
          ・第 2 局開藍後，第 3 局隊長的第一個提案照派開藍的隊伍 {ratioPct(reuse.reuse)}（{reuse.reuse.of} 局，這是慣例）
          {reuse.reuseBlue.of >= 5 && reuse.otherBlue.of >= 5 && `；照派時第 3 局開藍 ${ratioPct(reuse.reuseBlue)}（${reuse.reuseBlue.of}），不照派 ${ratioPct(reuse.otherBlue)}（${reuse.otherBlue.of}）`}。
        </p>
      )}
    </Takeaway>
  );
}
