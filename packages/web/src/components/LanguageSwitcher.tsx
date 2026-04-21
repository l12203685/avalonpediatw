import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { changeLocale, getCurrentLocale, SUPPORTED_LOCALES, type Locale } from '../i18n';

interface LanguageSwitcherProps {
  className?: string;
  variant?: 'compact' | 'full';
}

export default function LanguageSwitcher({
  className = '',
  variant = 'compact',
}: LanguageSwitcherProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Locale>(getCurrentLocale());

  useEffect(() => {
    const handleChange = (lng: string): void => {
      setCurrent(lng === 'en' || lng.startsWith('en-') ? 'en' : 'zh-TW');
    };
    i18n.on('languageChanged', handleChange);
    return () => {
      i18n.off('languageChanged', handleChange);
    };
  }, [i18n]);

  const handleSelect = (locale: Locale): void => {
    changeLocale(locale);
    setCurrent(locale);
    setOpen(false);
  };

  const currentLabel = t(`language.${current}`);

  return (
    <div className={`relative ${className}`}>
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 bg-zinc-900/70 backdrop-blur-sm px-2.5 py-2 rounded-lg border border-zinc-700 hover:border-white text-white text-sm font-semibold transition-colors"
        title={t('language.label')}
        aria-label={t('language.label')}
        aria-expanded={open}
      >
        <Languages size={14} />
        {variant === 'full' ? (
          <span>{currentLabel}</span>
        ) : (
          <span className="min-w-[1.5rem] text-center">{currentLabel}</span>
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
              className="absolute right-0 mt-2 z-50 min-w-[7rem] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
            >
              {SUPPORTED_LOCALES.map((locale) => (
                <button
                  key={locale}
                  onClick={() => handleSelect(locale)}
                  className={`w-full text-left px-3 py-2 text-sm font-semibold transition-colors ${
                    locale === current
                      ? 'bg-white/10 text-white'
                      : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                  }`}
                >
                  {t(`language.${locale}`)}
                  {locale === 'zh-TW' ? ' · 繁中' : ' · English'}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
