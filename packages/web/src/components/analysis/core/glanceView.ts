import type { TFunction } from 'i18next';
import { formatInt, type GlanceTone, type SplitSegment } from '../ui';
import { pctText, restText, type Sentence, type Share } from './glance';

/**
 * glance.ts 的結果 → 畫面上的字與比例條的兩段（總覽的卡片、任務、湖中女神共用，寫法才會全站一致）。
 * i18n 鍵都在 analytics.glance 底下。
 */
const G = 'analytics.glance';

/** glance.ts 的句子 → 文字。 */
export function sentenceText(t: TFunction, s: Sentence | null | undefined): string | null {
  return s ? t(`${G}.${s.key}`, s.params) : null;
}

/** 「共 982 局」「共 66,429 票」。 */
export function sampleText(t: TFunction, n: number, unit: 'games' | 'votes' = 'games'): string {
  return t(`${G}.sample.${unit}`, { n: formatInt(n) });
}

/** 藍方贏｜紅方贏。 */
export function winSegments(t: TFunction, blue: Share): SplitSegment[] {
  return [
    { pct: blue.pct, text: pctText(blue.pct), name: t(`${G}.blueWins`), tone: 'blue' },
    { pct: 100 - blue.pct, text: restText(blue.pct), name: t(`${G}.redWins`), tone: 'red' },
  ];
}

export function winLegend(t: TFunction): Array<{ name: string; tone: GlanceTone }> {
  return [{ name: t(`${G}.blueWins`), tone: 'blue' }, { name: t(`${G}.redWins`), tone: 'red' }];
}

/**
 * 反對｜贊成（黑白球：深灰＝反對、白＝贊成）。share 是哪一邊的比例由 side 指定，另一邊用減的（加起來 100%）。
 */
export function voteSegments(t: TFunction, share: Share, side: 'reject' | 'approve'): SplitSegment[] {
  const reject = side === 'reject';
  return [
    { pct: reject ? share.pct : 100 - share.pct, text: reject ? pctText(share.pct) : restText(share.pct), name: t(`${G}.votes.reject`), tone: 'no' },
    { pct: reject ? 100 - share.pct : share.pct, text: reject ? restText(share.pct) : pctText(share.pct), name: t(`${G}.votes.approve`), tone: 'yes' },
  ];
}

export function voteLegend(t: TFunction): Array<{ name: string; tone: GlanceTone }> {
  return [{ name: t(`${G}.votes.reject`), tone: 'no' }, { name: t(`${G}.votes.approve`), tone: 'yes' }];
}
