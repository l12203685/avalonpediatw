import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useAnalysisOverview } from './useAnalysisOverview';

/**
 * 各角色最終勝率表 (overview.roleFinalWinRates)：紅角 = 三紅 + 三藍死、
 * 藍角 = 三藍活。舊快取沒有這個欄位時整個區塊隱藏 (回 null)。
 */
const ROLE_ORDER = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣'];
const RED_ROLES = new Set(['刺客', '莫甘娜', '莫德雷德', '奧伯倫']);

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export default function RoleFinalWinRates(): JSX.Element | null {
  const { t } = useTranslation('common');
  const { overview } = useAnalysisOverview();
  const rates = overview?.roleFinalWinRates;
  if (!rates || typeof rates !== 'object') return null;

  const known = ROLE_ORDER.filter(r => hasOwn(rates, r) && typeof rates[r] === 'number');
  const extra = Object.keys(rates).filter(r => !ROLE_ORDER.includes(r) && typeof rates[r] === 'number');
  const roles = [...known, ...extra];
  if (roles.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
    >
      <h3 className="text-sm font-bold text-gray-400 mb-1">{t('analytics.deep.roleFinal.title')}</h3>
      <p className="text-[10px] text-gray-600 mb-3">{t('analytics.deep.roleFinal.sub')}</p>
      <div className="space-y-1.5">
        {roles.map(role => {
          const isRed = RED_ROLES.has(role);
          const v = rates[role];
          const width = Math.max(0, Math.min(100, v));
          return (
            <div key={role} className="flex items-center gap-2">
              <span className={`text-xs w-16 font-semibold ${isRed ? 'text-red-400' : 'text-blue-400'}`}>{role}</span>
              <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${isRed ? 'bg-red-500' : 'bg-blue-500'}`}
                  style={{ width: `${width}%` }}
                />
              </div>
              <span className="text-xs text-gray-300 w-12 text-right font-bold">{v.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-gray-600 mt-3">{t('analytics.deep.roleFinal.note')}</p>
    </motion.div>
  );
}
