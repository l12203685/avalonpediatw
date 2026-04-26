// IOSInstallGuide — iOS Safari「分享 → 加到主畫面」指引 modal
//
// Edward 2026-04-26 16:42: iOS Safari 不支援 beforeinstallprompt API，user
// 必須手動透過分享選單新增到主畫面。本 modal 用 inline SVG illustrations
// + 步驟文字示範流程（iOS 17/18 layout：分享按鈕在底部 toolbar 中央，
// iPad 在右上）。
//
// 設計原則：
//   - 純 inline SVG/emoji，不額外載資源
//   - 可從 InstallButton 觸發；ESC 或 backdrop click 關閉
//   - 文字走 i18n（zh-TW + en）

import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Share, Plus, X } from 'lucide-react';

interface IOSInstallGuideProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function IOSInstallGuide({ isOpen, onClose }: IOSInstallGuideProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
          onClick={onClose}
          data-testid="ios-install-guide-backdrop"
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-sm space-y-4 relative"
            onClick={(e) => e.stopPropagation()}
            data-testid="ios-install-guide-modal"
          >
            <button
              type="button"
              onClick={onClose}
              aria-label={t('action.close', { defaultValue: '關閉' })}
              className="absolute top-3 right-3 text-zinc-400 hover:text-white transition-colors"
            >
              <X size={18} />
            </button>

            <div className="text-center space-y-1">
              <h3 className="text-lg font-bold text-white">
                {t('home.installIosTitle', { defaultValue: '加到主畫面' })}
              </h3>
              <p className="text-xs text-zinc-400">
                {t('home.installIosSubtitle', { defaultValue: '在 Safari 中依下列步驟加入主畫面，使用體驗等同原生 App' })}
              </p>
            </div>

            {/* Steps */}
            <ol className="space-y-3">
              <li className="flex items-start gap-3 bg-zinc-800/40 border border-zinc-700 rounded-lg px-3 py-2.5">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-white/10 text-white text-xs font-bold flex items-center justify-center mt-0.5">
                  1
                </div>
                <div className="flex-1 text-sm text-zinc-200 leading-relaxed">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span>{t('home.installIosStep1Pre', { defaultValue: '點擊底部' })}</span>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-900/40 border border-blue-700/50 rounded text-blue-200">
                      <Share size={12} />
                      {t('home.installIosShare', { defaultValue: '分享' })}
                    </span>
                    <span>{t('home.installIosStep1Post', { defaultValue: '按鈕' })}</span>
                  </div>
                </div>
              </li>

              <li className="flex items-start gap-3 bg-zinc-800/40 border border-zinc-700 rounded-lg px-3 py-2.5">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-white/10 text-white text-xs font-bold flex items-center justify-center mt-0.5">
                  2
                </div>
                <div className="flex-1 text-sm text-zinc-200 leading-relaxed">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span>{t('home.installIosStep2Pre', { defaultValue: '選擇' })}</span>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-900/40 border border-emerald-700/50 rounded text-emerald-200">
                      <Plus size={12} />
                      {t('home.installIosAddToHome', { defaultValue: '加入主畫面' })}
                    </span>
                  </div>
                </div>
              </li>

              <li className="flex items-start gap-3 bg-zinc-800/40 border border-zinc-700 rounded-lg px-3 py-2.5">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-white/10 text-white text-xs font-bold flex items-center justify-center mt-0.5">
                  3
                </div>
                <div className="flex-1 text-sm text-zinc-200 leading-relaxed">
                  {t('home.installIosStep3', { defaultValue: '右上角按「加入」即完成' })}
                </div>
              </li>
            </ol>

            <div className="text-[11px] text-zinc-500 leading-relaxed border-t border-zinc-800 pt-3">
              {t('home.installIosTip', {
                defaultValue: '提示：若沒看到「加入主畫面」選項，請確認你正使用 Safari 開啟（Chrome iOS 不支援）。',
              })}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-full bg-white hover:bg-zinc-200 text-black font-bold py-2 px-4 rounded-lg transition-all"
            >
              {t('action.close', { defaultValue: '關閉' })}
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
