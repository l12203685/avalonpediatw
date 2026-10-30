import type { WikiRelationKind } from '../../utils/wikiGraph';

/** 關聯的顏色：本篇引用 = 琥珀、引用本篇 = 天藍、互相引用 = 翠綠（深色底上分得開，也和站上的黃色主色一致）。 */
export const RELATION_STROKE: Record<WikiRelationKind, string> = {
  out: '#fbbf24',
  in: '#38bdf8',
  both: '#34d399',
};

export const RELATION_TEXT_CLASS: Record<WikiRelationKind, string> = {
  out: 'text-amber-300',
  in: 'text-sky-300',
  both: 'text-emerald-300',
};

export const RELATION_CHIP_CLASS: Record<WikiRelationKind, string> = {
  out: 'border-amber-500/50 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20',
  in: 'border-sky-500/50 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20',
  both: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20',
};

export const RELATION_LABEL: Record<WikiRelationKind, string> = {
  out: '本篇引用',
  in: '引用本篇',
  both: '互相引用',
};
