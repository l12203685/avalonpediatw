import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * 角色名稱的雙語顯示 (2026-10-14 round 6 tabs-a)：快取裡的角色是中文全名 (刺客、莫甘娜…，
 * lake / seatPositionWinRates) 或單字 (刺、娜…，featureStudies)；英文介面要顯示英文。
 * 鍵在 analytics.r6.tabsa.roles.*。
 */

const ROLE_KEY: Readonly<Record<string, string>> = {
  刺客: 'assassin', 刺: 'assassin',
  莫甘娜: 'morgana', 娜: 'morgana',
  莫德雷德: 'mordred', 德: 'mordred',
  奧伯倫: 'oberon', 奧: 'oberon',
  派西維爾: 'percival', 派: 'percival',
  梅林: 'merlin', 梅: 'merlin',
  忠臣: 'loyal', 忠: 'loyal',
};

/** 固定顯示順序 (紅方四角 → 藍方三角，同 RoleFinalWinRates)。 */
export const ROLE_ORDER: readonly string[] = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣'];

/** 角色在 ROLE_ORDER 的位置 (單字也認得)；不認得的排最後。 */
export function roleOrderIndex(role: string): number {
  const key = ROLE_KEY[role];
  const i = ROLE_ORDER.findIndex(r => ROLE_KEY[r] === key);
  return i < 0 ? ROLE_ORDER.length : i;
}

/** 中文全名或單字 → 目前語言的角色名；不認得的原樣顯示。 */
export function useRoleLabel(): (role: string) => string {
  const { t } = useTranslation('common');
  return useCallback(
    (role: string): string => {
      const key = ROLE_KEY[role];
      return key ? t(`analytics.r6.tabsa.roles.${key}`) : role;
    },
    [t],
  );
}
