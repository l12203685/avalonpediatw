import { useEffect, useState } from 'react';

/** 寬度至少 640px 時依高度排列玩家卡，涵蓋桌機分割視窗與平板。 */
export const WIDE_BOARD_QUERY = '(min-width: 640px)';

/** 追蹤媒體條件，視窗縮放跨越門檻時重新渲染。 */
export function useMediaQuery(query: string): boolean {
  const read = (): boolean =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState<boolean>(read);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatches(mql.matches);
    onChange();
    // 相容舊版 Safari 的媒體查詢事件。
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return (): void => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return (): void => mql.removeListener(onChange);
  }, [query]);

  return matches;
}
