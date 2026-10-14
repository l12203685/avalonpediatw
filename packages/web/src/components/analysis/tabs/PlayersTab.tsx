import PlayerRadarChart from '../PlayerRadarChart';

/**
 * 分析 > 玩家雷達 (2026-10-14 拆成獨立檔案；內容在 PlayerRadarChart)。
 * focus = gameStore.statsFocus (排行的名字、#player= 連結)，選好那位玩家。
 */
export default function PlayersTab({ focus }: { focus: { name: string; seq: number } | null }): JSX.Element {
  return <PlayerRadarChart focus={focus} />;
}
