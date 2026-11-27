import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import zhTWCommon from './locales/zh-TW/common.json';
import zhTWGame from './locales/zh-TW/game.json';
import zhTWProfile from './locales/zh-TW/profile.json';
import zhTWLeaderboard from './locales/zh-TW/leaderboard.json';
import enCommon from './locales/en/common.json';
import enGame from './locales/en/game.json';
import enProfile from './locales/en/profile.json';
import enLeaderboard from './locales/en/leaderboard.json';
import { convertResourceTree, loadTwToCnConverter } from './opencc';

export const LOCALE_STORAGE_KEY = 'avalonpediatw-locale';
export const SUPPORTED_LOCALES = ['zh-TW', 'zh-CN', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'zh-TW';

const zhTWBundles = {
  common: zhTWCommon,
  game: zhTWGame,
  profile: zhTWProfile,
  leaderboard: zhTWLeaderboard,
} as const;

const resources = {
  'zh-TW': zhTWBundles,
  en: {
    common: enCommon,
    game: enGame,
    profile: enProfile,
    leaderboard: enLeaderboard,
  },
} as const;

let zhCNBundlesReady = false;

async function ensureZhCNBundles(): Promise<void> {
  if (zhCNBundlesReady) return;
  const convert = await loadTwToCnConverter();
  for (const [ns, bundle] of Object.entries(zhTWBundles)) {
    i18n.addResourceBundle('zh-CN', ns, convertResourceTree(bundle, convert), true, true);
  }
  zhCNBundlesReady = true;
}

function readStoredLocale(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (v === 'zh-TW' || v === 'zh-CN' || v === 'en') return v;
  } catch {
    // Storage unavailable (private mode / SSR)
  }
  return null;
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    defaultNS: 'common',
    ns: ['common', 'game', 'profile', 'leaderboard'],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    returnNull: false,
  });

export function normalizeLocale(lang: string | undefined): Locale {
  if (!lang) return DEFAULT_LOCALE;
  if (lang === 'en' || lang.startsWith('en-')) return 'en';
  if (lang === 'zh-CN' || lang === 'zh-SG' || lang.startsWith('zh-Hans')) return 'zh-CN';
  return 'zh-TW';
}

export async function changeLocale(locale: Locale): Promise<void> {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage not available — silently fall back to in-memory
  }
  if (locale === 'zh-CN') {
    await ensureZhCNBundles();
  }
  await i18n.changeLanguage(locale);
}

export function getCurrentLocale(): Locale {
  return normalizeLocale(i18n.language);
}

// 若瀏覽器先前已記憶簡體中文，啟動時才非同步補載轉換表
if (typeof window !== 'undefined' && readStoredLocale() === 'zh-CN') {
  void ensureZhCNBundles().then(() => i18n.changeLanguage('zh-CN'));
}

export default i18n;
