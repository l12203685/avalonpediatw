import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

interface BrandHeaderProps {
  /** Optional override for tagline (defaults to i18n `app.tagline`). */
  tagline?: string;
  /** Size variant — 'lg' matches HomePage, 'md' compact for sub-pages. */
  size?: 'lg' | 'md';
}

/**
 * Shared brand header — logo + AVALON title + tagline.
 *
 * Used on HomePage (大廳) and LoginPage so top-of-page branding stays
 * consistent. Logo source: `/logo.png`. Animation: spring scale in +
 * fade (opacity). Kept identical to HomePage "Title" block so the two
 * pages visually match.
 */
export default function BrandHeader({
  tagline,
  size = 'lg',
}: BrandHeaderProps): JSX.Element {
  const { t } = useTranslation();
  // Edward 2026-04-27 mobile single-viewport: lg variant on iPhone SE was
  // burning ~180px (logo 80 + h1 text-5xl 48 + tagline text-xl 28 + space-y-3
  // 24). Mobile shrink: logo 64 + text-4xl + text-lg + tighter space — saves
  // ~60px. Desktop unchanged.
  const logoSize = size === 'lg' ? 'w-16 sm:w-20 h-16 sm:h-20' : 'w-12 sm:w-16 h-12 sm:h-16';
  const titleSize =
    size === 'lg' ? 'text-4xl sm:text-5xl md:text-6xl' : 'text-3xl sm:text-4xl md:text-5xl';
  const taglineSize = size === 'lg' ? 'text-base sm:text-xl md:text-2xl' : 'text-sm sm:text-lg md:text-xl';

  return (
    <motion.div
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 200 }}
      className="space-y-2 sm:space-y-3 text-center"
    >
      <img
        src="/logo.png"
        alt={t('app.name')}
        className={`${logoSize} mx-auto rounded-2xl shadow-lg shadow-white/10`}
      />
      <h1 className={`${titleSize} font-black text-white drop-shadow-2xl`}>
        AVALON
      </h1>
      <p className={`${taglineSize} text-zinc-300 font-semibold`}>
        {tagline ?? t('app.tagline')}
      </p>
    </motion.div>
  );
}
