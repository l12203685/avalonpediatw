/**
 * 文字牌譜的一行，照記號上色（站長 2026-11-17：「文字部分我覺得異常票有變色不錯 百科網站上的文字紀錄呈現也可以調整」，
 * 跟 Threads 每日一題圖上的文字紀錄同一套配色）。切段的規則在 utils/records.ts 的 recordLineParts（有測試）。
 */
import { isMissionTextLine, recordLineParts, type RecordTextPart } from '../../utils/records';

const PART_CLASS: Record<RecordTextPart['kind'], string> = {
  team: 'text-zinc-100',
  mark: 'font-bold text-emerald-400',
  missionRed: 'font-bold text-red-300',
  missionBlue: 'font-bold text-blue-300',
  lake: 'text-cyan-200',
  claimGood: 'font-bold text-blue-300',
  claimEvil: 'font-bold text-red-300',
  plain: '',
};

export function RecordTextLine({ line, roundIndex }: { line: string; roundIndex?: number }): JSX.Element {
  return (
    <span>
      {recordLineParts(line, roundIndex).map((p, i) => (
        <span key={i} className={PART_CLASS[p.kind]} data-kind={p.kind}>{p.text}</span>
      ))}
    </span>
  );
}

/** 整段 DC 文字牌譜（一行一個 RecordTextLine）；任務行依出現順序算第幾輪。 */
export function RecordTextBlock({ text }: { text: string }): JSX.Element {
  let round = -1;
  return (
    <>
      {text.split('\n').map((line, i) => {
        const mission = isMissionTextLine(line);
        if (mission) round++;
        return (
          <div key={i}>
            <RecordTextLine line={line} roundIndex={mission ? round : undefined} />
          </div>
        );
      })}
    </>
  );
}
