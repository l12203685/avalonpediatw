/**
 * 「最常見的路徑」那句話的比例（PR #54 審查）：分母要是全部有路徑的局，不能是表上列出的路徑加總——
 * 快取的 gameStates 只留最常見的 20 種、也不含沒有路徑的局，加總會變小、最常見那條的比例被高估。
 * 用任務 1 分支（成功＋失敗）的局數當分母，同「任務 1 成功／失敗之後」那張表與舊的任務進程那句話。
 * 沒有分支的局數（舊快取）或對不上（比最常見那條還少）時回傳 null，那句話不顯示。
 */
export interface TopPathShare { path: string; n: number; total: number; share: number }

export function topPathShare(data: {
  gameStates?: ReadonlyArray<{ state: string; games: number }> | null;
  mission1Branch?: ReadonlyArray<{ games: number }> | null;
}): TopPathShare | null {
  const top = data.gameStates?.[0];
  if (!top || !(top.games > 0)) return null;
  const total = (data.mission1Branch ?? []).reduce((sum, b) => sum + (Number.isFinite(b.games) ? b.games : 0), 0);
  if (!(total >= top.games)) return null;
  return { path: top.state, n: top.games, total, share: (top.games / total) * 100 };
}
