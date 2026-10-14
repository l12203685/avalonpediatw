import { useTranslation } from 'react-i18next';
import { roleFaction } from '../../../services/api';
import type { AnalysisTheorySettings, OutcomeBlocks } from '../../../services/api';
import { MetricBlocks, type MetricBlockRow } from '../ui';
import { orderedRoles, type PlayerRadarModel } from './radarModel';

/**
 * 玩家雷達 > 三塊勝率 (2026-10-14 Edward：「角色勝率那邊應該分三塊」— 任務結果、刺殺結果、遊戲結果，
 * 每格是條件機率並附 n；例：紅方的刺殺結果 = 三藍死 / 我是紅方且打到三藍的局，不是 / 全部紅方場)。
 *
 * 列：紅方、藍方 (原始計數，舊快取也有)，再來七個角色 (players[].roleOutcomes，schemaVersion 4；
 * 舊快取只列紅藍兩列並提示「下次每日更新後提供」)。數字全由 @avalon/shared playerOutcomeBlocks 算好，
 * 這裡只排列。取代舊的「詳細數據」側欄與任務結算口徑的「角色勝率」長條。
 * 樣本少的格子變淡，門檻 = 快取的 theoryMinCellGames (與理論勝率補值同一個數)。
 */
export default function BlocksPanel({
  model, settings,
}: { model: PlayerRadarModel; settings: AnalysisTheorySettings }): JSX.Element {
  const { t } = useTranslation('common');
  const { blocks } = model;

  const row = (key: string, label: string, b: OutcomeBlocks, tone: 'red' | 'blue'): MetricBlockRow => ({
    key,
    label,
    tone,
    mission: b.mission,
    assassination: b.assassination,
    final: b.final,
  });

  const rows: MetricBlockRow[] = [];
  if (blocks.red) rows.push(row('red', t('analytics.ui.blocks.red'), blocks.red, 'red'));
  if (blocks.blue) rows.push(row('blue', t('analytics.ui.blocks.blue'), blocks.blue, 'blue'));
  const roles = blocks.roles;
  if (roles) {
    for (const role of orderedRoles(Object.keys(roles))) {
      rows.push(row(`role:${role}`, role, roles[role], roleFaction(role)));
    }
  }

  const minCell = settings.theoryMinCellGames;

  return (
    <MetricBlocks
      className="lg:max-w-4xl"
      rows={rows}
      lowSample={minCell > 0 ? minCell : undefined}
      groupLabel={t('analytics.r6.radar.blocks.group')}
      empty={t('analytics.r6.radar.blocks.empty')}
      footnote={
        rows.length > 0 && (
          roles
            ? t('analytics.r6.radar.blocks.rolesNote')
            : <span className="text-amber-300/80">{t('analytics.r6.radar.blocks.rolesPending')}</span>
        )
      }
    />
  );
}
