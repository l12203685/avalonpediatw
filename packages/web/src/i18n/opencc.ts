export type TextConverter = (text: string) => string;

let loadedConverter: TextConverter | null = null;
let pendingPromise: Promise<TextConverter> | null = null;

/** 是否已載入簡繁轉換表（未選簡體前應維持 false，避免無謂增加初始 bundle）。 */
export function isTwToCnLoaded(): boolean {
  return loadedConverter !== null;
}

/** 僅在切換到簡體中文（zh-CN）時才動態載入 opencc-js（tw → cn）。 */
export function loadTwToCnConverter(): Promise<TextConverter> {
  if (loadedConverter) return Promise.resolve(loadedConverter);
  if (!pendingPromise) {
    pendingPromise = import('opencc-js').then((mod) => {
      const factory = mod.Converter ?? (mod as unknown as { default?: { Converter?: typeof mod.Converter } }).default?.Converter;
      if (!factory) {
        throw new Error('opencc-js Converter export not found');
      }
      const convert = factory({ from: 'tw', to: 'cn' });
      loadedConverter = convert;
      return convert;
    });
  }
  return pendingPromise;
}

const INTERPOLATION_RE = /(\{\{[^}]+\}\})/g;

/** 轉換單段字串，同時保留 i18next 的 {{placeholder}} 插值名稱不變。 */
export function convertI18nString(text: string, convert: TextConverter): string {
  if (!text.includes('{{')) return convert(text);
  return text
    .split(INTERPOLATION_RE)
    .map((part) => (part.startsWith('{{') && part.endsWith('}}') ? part : convert(part)))
    .join('');
}

/** 遞迴轉換 i18n 資源樹（供顯示時即時產生 zh-CN 介面字串，不在 repo 另存簡體檔）。 */
export function convertResourceTree<T>(value: T, convert: TextConverter): T {
  if (typeof value === 'string') {
    return convertI18nString(value, convert) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => convertResourceTree(item, convert)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = convertResourceTree(v, convert);
    }
    return out as T;
  }
  return value;
}
