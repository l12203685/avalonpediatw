import OverviewPanel from '../OverviewPanel';

/** 分析 > 總覽 (2026-10-14 拆成獨立檔案；內容在 OverviewPanel)。 */
export default function OverviewTab({ onOpenAssassination }: { onOpenAssassination: () => void }): JSX.Element {
  return <OverviewPanel onOpenAssassination={onOpenAssassination} />;
}
