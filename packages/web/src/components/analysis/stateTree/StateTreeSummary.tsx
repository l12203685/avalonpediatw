import { useTranslation } from 'react-i18next';
import { Advanced, GlanceLegend, GlanceRow, PathChips, SplitBar, Takeaway } from '../ui';
import { stateTreeGlance } from '../core/glance';
import { sampleText, sentenceText, winLegend, winSegments } from '../core/glanceView';
import { pct, ratioPct } from './NodeDetail';
import type { StateTreeFindings } from './stateTree';

function scoreText(score: string): string {
  const [b, r] = score.split(':');
  return `${b} 個任務成功、${r} 個失敗`;
}

/** 百分點差（0–1 → 「14 個百分點」）。 */
function points(x: number): string {
  return `${Math.round(Math.abs(x) * 100)} 個百分點`;
}

const G = 'analytics.glance.tree';

/**
 * 局勢樹上面的說明（站長 2026-11-25：「希望能更直觀讓看到的人一目瞭然」，第三批）：原本一大段「看得出什麼」＋一段怎麼讀圖的小字，
 * 改成
 *  - 一句話：同樣的比分、順序不同，藍方最後贏差多少（差最多的那一組；core/glance.ts stateTreeGlance）＋兩條「藍方贏｜紅方贏」比例條；
 *  - 「怎麼看這棵樹」收合：每一層是什麼、顏色、粗細、細條、怎麼點；
 *  - 「還看得出什麼」收合：其他比分的順序對照、第 2 個任務後第一次湖的宣告、照派（原本那幾句，換成白話）。
 * 數字都是目前篩選下的局算的（stateTreeFindings），跟原本同一組，不寫死結論。
 */
export default function StateTreeSummary({ f, desktop, excluded }: { f: StateTreeFindings; desktop: boolean; excluded: number }): JSX.Element | null {
  const { t } = useTranslation('common');
  if (!f.total) return null;
  const glance = stateTreeGlance(f);
  const lake = f.lakeAfterR2;
  const reuse = f.reuseAfterR2Blue;
  const byBad = [...lake.bySeq].sort((a, b) => b.badShare - a.badShare);
  // 一句話講的是第一組對照；其餘的放「還看得出什麼」
  const others = f.contrasts.filter((c) => c.high.seq !== glance.high?.seq || c.low.seq !== glance.low?.seq).slice(0, 2);
  const hasMore = others.length > 0 || Boolean(lake.pooled) || Boolean(reuse && reuse.reuse.of > 0);
  const chips = (seq: string): JSX.Element => <PathChips path={seq} label={seq} />;
  return (
    <div className="space-y-2" data-testid="state-tree-summary">
      <Takeaway>
        <p className="text-sm font-semibold text-white sm:text-[15px]" data-testid="state-tree-lead">{sentenceText(t, glance.sentence)}</p>
        {glance.high && glance.low && (
          <div className="space-y-1.5 pt-1.5">
            <GlanceLegend items={winLegend(t)} />
            {[glance.high, glance.low].map((row) => (
              <GlanceRow
                key={row.seq}
                label={<span className="inline-flex items-center gap-1.5">{chips(row.seq)}<span>{row.seq} {t(`${G}.after`)}</span></span>}
                sample={sampleText(t, row.blue.n)}
              >
                <SplitBar segments={winSegments(t, row.blue)} sample={sampleText(t, row.blue.n)} />
              </GlanceRow>
            ))}
            <p className="text-[11px] text-zinc-500">{t(`${G}.legend`)}</p>
          </div>
        )}
      </Takeaway>

      <Advanced title={t(`${G}.howTo`)} testId="state-tree-howto">
        {() => (
          <ul className="list-disc space-y-1 pl-5 pr-1 text-xs leading-relaxed text-zinc-300 marker:text-zinc-600">
            <li>由左到右是第 1 到第 5 個任務，每個任務分成兩條路：藍＝任務成功、紅＝任務失敗（第 4 個任務要兩張失敗票才算失敗）。</li>
            <li>第 2、3、4 個任務之後多一層湖中女神的宣告：「說好」＝說對方是藍方，「說壞」＝說對方是紅方。藍方拿湖照慣例說真話，紅方可能說謊。</li>
            <li>每一格寫的是走到這裡的局數，和它佔上一格的比例；線越粗，局數越多。</li>
            <li>格子的顏色：越藍＝走到這裡之後藍方贏得比平常多，越紅＝紅方贏得比平常多，灰色＝跟全部的局差不多。</li>
            <li>格子下面的細條是三種結局：紅＝三個任務失敗，紫紅＝藍方做完三個任務但梅林被刺中，藍＝藍方贏。</li>
            <li>虛線框的「其他」＝局數太少的走法加在一起（門檻可以在上面改）。</li>
            <li>{desktop ? '滑過或點一格看細節，點 +／− 展開、收合。' : '點一列展開，並看那一格的細節。'}</li>
            {excluded > 0 && <li>另有 {excluded} 局沒有列入：任務沒打完、不是 10 人局的標準隊伍人數，或結果跟任務對不上。</li>}
          </ul>
        )}
      </Advanced>

      {hasMore && (
        <Advanced title={t(`${G}.more`)} testId="state-tree-more">
          {() => (
            <ul className="list-disc space-y-1.5 pl-5 pr-1 text-xs leading-relaxed text-zinc-300 marker:text-zinc-600">
              <li>
                這 {f.total} 局裡，藍方最後贏 {pct(f.baseline.blueWin)}；三個任務失敗、紅方直接贏的有 {pct(f.baseline.threeRed)}。
              </li>
              {others.map((c) => (
                <li key={c.score}>
                  同樣 {scoreText(c.score)}：<b>{c.high.seq}</b> 之後（{c.high.n} 局）藍方最後贏 {pct(c.high.blueWin)}，
                  <b>{c.low.seq}</b> 之後（{c.low.n} 局）只有 {pct(c.low.blueWin)}；三個任務失敗的比例是 {pct(c.high.threeRed)} 對 {pct(c.low.threeRed)}。
                </li>
              ))}
              {lake.pooled && (
                <li>
                  第 2 個任務後的第一次湖：說好的局（{lake.pooled.good.n} 局）藍方最後贏 {pct(lake.pooled.good.blueWin)}，
                  說壞的局（{lake.pooled.bad.n} 局）{pct(lake.pooled.bad.blueWin)}，全部放在一起看差 {points((lake.pooled.good.blueWin ?? 0) - (lake.pooled.bad.blueWin ?? 0))}
                  {lake.withinGap !== null && lake.bySeq.length >= 2 && (
                    <>
                      ；但只在前兩個任務結果一樣的局裡比，平均只差 {points(lake.withinGap)}
                      {byBad.length >= 2 && `（「說壞」在 ${byBad[0].seq} 之後最常見，佔 ${pct(byBad[0].badShare)}；${byBad[byBad.length - 1].seq} 之後只有 ${pct(byBad[byBad.length - 1].badShare)}。所以放在一起看的差距，有一部分是前兩個任務本身造成的）`}
                    </>
                  )}
                  。
                  {lake.bySeq[0] && (
                    <>
                      差最多的是 {lake.bySeq[0].seq} 之後：說好 {pct(lake.bySeq[0].good.blueWin)}（{lake.bySeq[0].good.n} 局）、
                      說壞 {pct(lake.bySeq[0].bad.blueWin)}（{lake.bySeq[0].bad.n} 局）。
                    </>
                  )}
                </li>
              )}
              {reuse && reuse.reuse.of > 0 && (
                <li>
                  第 2 個任務成功後，第 3 個任務的隊長第一次提議就照派上一支成功的隊伍：{ratioPct(reuse.reuse)}（共 {reuse.reuse.of} 局，這是慣例）
                  {reuse.reuseBlue.of >= 5 && reuse.otherBlue.of >= 5 && `；照派的局第 3 個任務成功 ${ratioPct(reuse.reuseBlue)}（${reuse.reuseBlue.of} 局），不照派的 ${ratioPct(reuse.otherBlue)}（${reuse.otherBlue.of} 局）`}。
                </li>
              )}
            </ul>
          )}
        </Advanced>
      )}
    </div>
  );
}
