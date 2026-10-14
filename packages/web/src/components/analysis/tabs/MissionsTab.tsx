import MissionAnalysis from '../MissionAnalysis';

/**
 * 分析 > 任務 (2026-10-14 拆成獨立檔案；內容在 MissionAnalysis)。
 * (2026-10-14 Edward：一頁一屏) MissionAnalysis 內用 SectionTabs 分成「通過率」「任務 → 結局」兩頁。
 */
export default function MissionsTab(): JSX.Element {
  return <MissionAnalysis />;
}
