import PlayerRadarChart from '../PlayerRadarChart';

/**
 * 分析 > 玩家雷達 (2026-10-14 拆成獨立檔案；內容在 PlayerRadarChart)。
 * (2026-10-14 Edward：一個分頁一屏) 內容分成 雷達圖／三塊勝率／理論勝率 三個小分頁，
 * 各小分頁的元件在 components/analysis/radar/。
 * focus = gameStore.statsFocus (排行的名字、#player= 連結)，選好那位玩家。
 */
export default function PlayersTab({ focus }: { focus: { name: string; seq: number } | null }): JSX.Element {
  return <PlayerRadarChart focus={focus} />;
}
