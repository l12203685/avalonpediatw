/**
 * 預設集（r9 設計 §3.7；網站的 chips、機器人的短碼 #stats?preset=…）。lastYear 依 asOf 展開成固定日期，
 * 分享連結存展開後的篩選。
 */
import { addDays } from '../leaderboard';
import type { GameFilter } from './types';

export interface FilterPreset {
  id: 'online' | 'offline' | 'noCasual' | 'fullNames' | 'lastYear';
  label: string;
  labelEn: string;
  build(asOf: string): GameFilter;
}

export const PRESETS: readonly FilterPreset[] = [
  { id: 'online', label: '只看線瓦', labelEn: 'Online only', build: () => ({ v: 1, clauses: [{ kind: 'category', in: ['線瓦'] }] }) },
  { id: 'offline', label: '只看面瓦', labelEn: 'Offline only', build: () => ({ v: 1, clauses: [{ kind: 'category', in: ['面瓦'] }] }) },
  {
    id: 'noCasual', label: '排除娛樂局', labelEn: 'No casual games',
    build: () => ({ v: 1, clauses: [{ kind: 'category', in: ['娛樂'], not: true }] }),
  },
  { id: 'fullNames', label: '只看 10 人全寫', labelEn: 'All ten names recorded', build: () => ({ v: 1, clauses: [{ kind: 'namedSeats', min: 10 }] }) },
  {
    id: 'lastYear', label: '近一年', labelEn: 'Last 12 months',
    build: (asOf) => ({ v: 1, clauses: [{ kind: 'date', from: addDays(asOf, -364), to: asOf }] }),
  },
];

export function presetFilter(id: string, asOf: string): GameFilter | null {
  const preset = PRESETS.find((p) => p.id === id);
  return preset ? preset.build(asOf) : null;
}
