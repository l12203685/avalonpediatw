import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, HelpCircle, Shield, ChevronDown, User, Users, Gamepad2 } from 'lucide-react';
import { useGameStore } from '../store/gameStore';

interface FaqItem {
  q: string;
  a: string | JSX.Element;
}

interface FaqSection {
  id: string;
  title: string;
  icon: JSX.Element;
  items: FaqItem[];
}

const FAQ_SECTIONS: FaqSection[] = [
  {
    id: 'auth',
    title: '認證 / 帳號',
    icon: <User size={18} className="text-white" />,
    items: [
      {
        q: '為什麼一進來就是訪客身分？',
        a: (
          <>
            Avalon 開放即玩、不強迫註冊。訪客玩的對局都會記在你的
            <span className="text-white font-semibold"> 訪客 UUID </span>
            下，之後綁定帳號（Line / Discord / Gmail）時，戰績會自動遷移合併。
          </>
        ),
      },
      {
        q: '訪客可以做什麼、不能做什麼？',
        a: (
          <>
            <span className="text-white font-semibold">可以：</span>
            開房 / 加入房間 / 玩對局 / 看自己訪客戰績。
            <br />
            <span className="text-white font-semibold">不能：</span>
            加好友 / 出現在排行榜 / 看歷史對局回放。
          </>
        ),
      },
      {
        q: '訪客戰績會丟嗎？',
        a: (
          <>
            訪客戰績綁在裝置 UUID。如果清瀏覽器，UUID 會丟。建議玩 1-2 局後綁帳號
            （Line / Discord / Gmail 任選）就能跨裝置保留戰績。
          </>
        ),
      },
      {
        q: '多裝置可以用同一個帳號嗎？',
        a: '可以。同一個 Line / Discord / Gmail 在電腦 + 手機都登入，戰績自動同步。',
      },
      {
        q: '可以同時綁定多種帳號嗎？',
        a: '可以。Line + Discord + Gmail 三種任意綁，所有戰績都集中在同一個 user_id 下。',
      },
    ],
  },
  {
    id: 'identity',
    title: '撞名 / 識別',
    icon: <Users size={18} className="text-white" />,
    items: [
      {
        q: '為什麼有些玩家暱稱看起來一樣？',
        a: (
          <>
            暱稱可重複（自由命名）。系統用
            <span className="text-white font-semibold"> user_id </span>
            （背後唯一 ID）區分玩家，不靠暱稱。將來會加上短碼讓你辨識同名玩家。
          </>
        ),
      },
      {
        q: '怎麼加好友？',
        a: '好友頁有搜尋 / 加好友功能，透過暱稱 + ID 配對。詳見好友頁。',
      },
    ],
  },
  {
    id: 'game',
    title: '遊戲',
    icon: <Gamepad2 size={18} className="text-white" />,
    items: [
      {
        q: '對局途中斷線怎麼辦？',
        a: '重新整理回到房間，系統會接回對局（前提：未超過離線重連時間限制）。',
      },
    ],
  },
];

const PRIVACY_POINTS: { label: string; detail: string }[] = [
  {
    label: '資料用途',
    detail: '純粹顯示戰績 + 排行榜 + 好友，不做廣告、不轉售第三方。',
  },
  {
    label: '認證資料',
    detail: 'Line / Discord / Gmail 只取 unique ID + 顯示名稱，不取通訊錄、不取個資。',
  },
  {
    label: '訪客 UUID',
    detail: '只存在你的瀏覽器 + 我們的 DB，不串接任何身分。',
  },
  {
    label: '對局紀錄',
    detail: '用於戰績 / 排行榜 / 回放、開發者內部分析，不外洩。',
  },
  {
    label: '你的權利',
    detail: '可隨時要求刪除帳號 + 戰績（聯絡管理員 Discord）。',
  },
];

interface FaqAccordionProps {
  item: FaqItem;
  isOpen: boolean;
  onToggle: () => void;
}

function FaqAccordion({ item, isOpen, onToggle }: FaqAccordionProps): JSX.Element {
  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden bg-zinc-900/40">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-zinc-900/70 transition-colors"
        aria-expanded={isOpen}
      >
        <span className="font-semibold text-white text-sm md:text-base flex-1">
          {item.q}
        </span>
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0"
        >
          <ChevronDown size={18} className="text-zinc-400" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1 text-sm md:text-[15px] text-zinc-300 leading-relaxed border-t border-zinc-800">
              {item.a}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function HelpPage(): JSX.Element {
  const { setGameState } = useGameStore();
  const [openKey, setOpenKey] = useState<string | null>(null);

  const toggle = (key: string): void => {
    setOpenKey(prev => (prev === key ? null : key));
  };

  return (
    <div className="min-h-screen bg-black p-4">
      {/* Background decorations */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <motion.div
          animate={{
            x: [0, 40, 0],
            y: [0, 25, 0],
            opacity: [0.04, 0.1, 0.04],
          }}
          transition={{ duration: 22, repeat: Infinity }}
          className="absolute top-10 right-10 w-96 h-96 bg-white rounded-full blur-3xl"
        />
        <motion.div
          animate={{
            x: [0, -40, 0],
            y: [0, -25, 0],
            opacity: [0.03, 0.08, 0.03],
          }}
          transition={{ duration: 28, repeat: Infinity }}
          className="absolute bottom-10 left-10 w-96 h-96 bg-white rounded-full blur-3xl"
        />
      </div>

      <div className="relative z-10 max-w-3xl mx-auto space-y-8 pb-16">
        {/* Header */}
        <div className="flex items-center gap-3 pt-2">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setGameState('home')}
            className="flex items-center gap-2 bg-zinc-900/70 hover:bg-zinc-800 text-white px-3 py-2 rounded-lg border border-zinc-700 hover:border-white transition-all"
          >
            <ArrowLeft size={18} />
            返回
          </motion.button>
          <div className="flex items-center gap-2">
            <HelpCircle size={22} className="text-white" />
            <h1 className="text-2xl md:text-3xl font-black text-white">
              常見問題 & 隱私說明
            </h1>
          </div>
        </div>

        {/* Intro */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 md:p-6"
        >
          <p className="text-zinc-300 text-sm md:text-base leading-relaxed">
            這裡說明 Avalon 的
            <span className="text-white font-semibold"> 身分認證機制 </span>
            （為什麼有訪客、為什麼可以綁多帳號）與
            <span className="text-white font-semibold"> 隱私處理 </span>
            （資料怎麼用）。有其他疑問請到首頁點「回報問題」或聯絡管理員 Discord。
          </p>
        </motion.div>

        {/* FAQ sections */}
        {FAQ_SECTIONS.map((section, sectionIdx) => (
          <motion.section
            key={section.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 + sectionIdx * 0.05 }}
            className="space-y-3"
          >
            <div className="flex items-center gap-2 px-1">
              {section.icon}
              <h2 className="text-lg md:text-xl font-bold text-white">
                {section.title}
              </h2>
              <span className="text-xs text-zinc-500">
                ({section.items.length})
              </span>
            </div>
            <div className="space-y-2">
              {section.items.map((item, itemIdx) => {
                const key = `${section.id}-${itemIdx}`;
                return (
                  <FaqAccordion
                    key={key}
                    item={item}
                    isOpen={openKey === key}
                    onToggle={() => toggle(key)}
                  />
                );
              })}
            </div>
          </motion.section>
        ))}

        {/* Privacy section */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="space-y-3"
        >
          <div className="flex items-center gap-2 px-1">
            <Shield size={18} className="text-white" />
            <h2 className="text-lg md:text-xl font-bold text-white">
              隱私說明
            </h2>
          </div>
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 md:p-6 space-y-4">
            {PRIVACY_POINTS.map((point) => (
              <div
                key={point.label}
                className="flex flex-col md:flex-row md:gap-4 pb-3 border-b border-zinc-800 last:border-b-0 last:pb-0"
              >
                <div className="text-white font-semibold text-sm md:text-base w-full md:w-32 flex-shrink-0 mb-1 md:mb-0">
                  {point.label}
                </div>
                <div className="text-zinc-300 text-sm md:text-[15px] leading-relaxed flex-1">
                  {point.detail}
                </div>
              </div>
            ))}
          </div>
        </motion.section>

        {/* Footer note */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
          className="text-xs text-zinc-500 pt-4 border-t border-zinc-800 text-center"
        >
          <p>
            本頁最後更新：2026-04-21 · 若條款異動，以本頁為準。
          </p>
        </motion.div>
      </div>
    </div>
  );
}
