import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { changeLocale, getCurrentLocale, normalizeLocale, SUPPORTED_LOCALES, type Locale } from '../i18n';

interface LanguageSwitcherProps {
  className?: string;
  variant?: 'compact' | 'full';
}

const LOCALE_SUFFIX: Record<Locale, string> = {
  'zh-TW': '繁中',
  'zh-CN': '简中',
  en: 'English',
};

export default function LanguageSwitcher({
  className = '',
  variant = 'compact',
}: LanguageSwitcherProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Locale>(getCurrentLocale());

  useEffect(() => {
    const handleChange = (lng: string): void => {
      setCurrent(normalizeLocale(lng));
    };
    i18n.on('languageChanged', handleChange);
    return (): void => {
      i18n.off('languageChanged', handleChange);
    };
  }, [i18n]);

  const handleSelect = (locale: Locale): void => {
    void changeLocale(locale);
    setCurrent(locale);
    setOpen(false);
  };

  const currentLabel = t(`language.${current}`, { defaultValue: current === 'zh-CN' ? '简' : current === 'en' ? 'EN' : '繁' });

  return (
    <div className={`relative ${className}`} data-testid="language-switcher">
      <motion.button
        type="button"
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs font-semibold text-zinc-200 transition-colors hover:border-white hover:bg-zinc-800 hover:text-white"
        title={t('language.label')}
        aria-label={t('language.label')}
        aria-expanded={open}
      >
        <Languages size={14} className="flex-shrink-0" />
        {variant === 'full' ? (
          <span>{currentLabel}</span>
        ) : (
          <span className="min-w-[1.25rem] text-center">{currentLabel}</span>
        )}
      </motion.button>

      <AnimatePresence>
        {open && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.95 }}
              transition={{ duration: 0.12 }}
              className="absolute right-0 mt-2 z-50 min-w-[7.5rem] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
            >
              {SUPPORTED_LOCALES.map((locale) => (
                <button
                  key={locale}
                  type="button"
                  data-testid={`lang-option-${locale}`}
                  onClick={() => handleSelect(locale)}
                  className={`w-full px-3 py-2 text-left text-xs font-semibold transition-colors ${
                    locale === current
                      ? 'bg-white/10 text-white'
                      : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                  }`}
                >
                  {t(`language.${locale}`, { defaultValue: locale })} · {LOCALE_SUFFIX[locale]}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
