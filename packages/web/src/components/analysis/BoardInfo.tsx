import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisLeaderboardBoard } from '../../services/api';

/**
 * 排行各榜的說明：統計範圍 (快取的 period) + 上榜 (note 的第一句) + 視窗與定義 (note 其餘子句)。
 * (2026-10-30 Edward：「理論勝率的右邊 上綁文字說明有點太過冗長」) 原本整欄印在表格右邊，改放進
 * 標題旁的 ⓘ (InfoTip) 與說明頁的「統計名詞與算法」，兩邊用這同一份；文字一律讀快取，不另寫。
 */
export function boardText(board: AnalysisLeaderboardBoard, isEn: boolean): { title: string; period: string; who?: string; rest: string[] } {
  const note = isEn && board.noteEn ? board.noteEn : board.note;
  const [who, ...rest] = (note ?? '').split(/[；;]/).map((s) => s.trim()).filter(Boolean);
  return {
    title: isEn && board.titleEn ? board.titleEn : board.title,
    period: isEn && board.periodEn ? board.periodEn : board.period,
    who,
    rest,
  };
}

export default function BoardInfo({
  board, isEn, children,
}: {
  board: AnalysisLeaderboardBoard;
  isEn: boolean;
  /** 接在定義後面的補充 (淡色、n 的意思、點一列…)。 */
  children?: ReactNode;
}): JSX.Element {
  const { t } = useTranslation('common');
  const { period, who, rest } = boardText(board, isEn);
  return (
    <div className="space-y-1.5">
      {period && (
        <p>
          <span className="font-semibold text-zinc-100">{t('analytics.ui.info.period')}</span>
          {period}
        </p>
      )}
      {who && (
        <p>
          <span className="font-semibold text-zinc-100">{t('analytics.r6.boards.who')}</span>
          {who}
        </p>
      )}
      {rest.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 marker:text-zinc-600">
          {rest.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      )}
      {children}
    </div>
  );
}
