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

export const LOCALE_STORAGE_KEY = 'avalonpediatw-locale';
export const SUPPORTED_LOCALES = ['zh-TW', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'zh-TW';

const resources = {
  'zh-TW': {
    common: zhTWCommon,
    game: zhTWGame,
    profile: zhTWProfile,
    leaderboard: zhTWLeaderboard,
  },
  en: {
    common: enCommon,
    game: enGame,
    profile: enProfile,
    leaderboard: enLeaderboard,
  },
} as const;

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

export function changeLocale(locale: Locale): void {
  void i18n.changeLanguage(locale);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage not available — silently fall back to in-memory
  }
}

export function getCurrentLocale(): Locale {
  const lang = i18n.language;
  if (lang === 'en' || lang.startsWith('en-')) return 'en';
  return 'zh-TW';
}

export default i18n;
