// useInstallPrompt — PWA install state hook
//
// Edward 2026-04-26 16:42: 加 PWA「加到桌面」按鈕。Manifest + icons 已 ship
// (Task #37)；本 hook 提供：
//   - deferredPrompt: Chrome/Edge/Android 的 beforeinstallprompt event
//   - isStandalone: 已裝過 (display-mode: standalone) → 隱藏按鈕
//   - isIOS: iOS Safari 須走「分享 → 加到主畫面」手動流程
//   - promptInstall(): wrapper for deferredPrompt.prompt()
//
// Browser support：
//   - Chrome/Edge/Opera (Android+Desktop)：beforeinstallprompt 自動觸發
//   - Safari (iOS)：不支援 prompt API，必須手動指引
//   - Firefox mobile：部分支援

import { useCallback, useEffect, useState } from 'react';

// BeforeInstallPromptEvent 不在標準 lib.dom.d.ts，自定義 minimal interface。
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

type NavigatorWithStandalone = Navigator & { standalone?: boolean };

export interface UseInstallPromptResult {
  /** Chrome/Edge/Android 拿到的 prompt event；未拿到時為 null */
  deferredPrompt: BeforeInstallPromptEvent | null;
  /** 是否已在 standalone 模式（已裝過 PWA） */
  isStandalone: boolean;
  /** 是否 iOS Safari（必須走手動「分享 → 加到主畫面」流程） */
  isIOS: boolean;
  /** 是否裝完 → appinstalled fired */
  isInstalled: boolean;
  /** 觸發瀏覽器 install dialog（僅在 deferredPrompt 有值時可用）*/
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

function detectIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPad on iOS 13+ reports as Mac — fall back to touch + maxTouchPoints check.
  const isAppleMobile = /iPad|iPhone|iPod/.test(ua);
  const isIPadDesktopMode =
    ua.includes('Mac') && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
  // MSStream 排除 Windows Phone / IE Mobile false positive。
  const hasMSStream = (window as unknown as { MSStream?: unknown }).MSStream;
  return (isAppleMobile || isIPadDesktopMode) && !hasMSStream;
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // matchMedia: Chrome / Android / Edge / Desktop PWA
  const standaloneMq = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  // navigator.standalone: iOS Safari home-screen-installed flag
  const iosStandalone = (navigator as NavigatorWithStandalone).standalone === true;
  return standaloneMq || iosStandalone;
}

export function useInstallPrompt(): UseInstallPromptResult {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(() => detectStandalone());
  const [isInstalled, setIsInstalled] = useState<boolean>(false);
  const isIOS = detectIOS();

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event): void => {
      // Cancel default mini-infobar (Chrome on mobile) so we control when prompt() fires.
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = (): void => {
      setIsInstalled(true);
      setDeferredPrompt(null);
      setIsStandalone(true);
    };

    const handleDisplayModeChange = (e: MediaQueryListEvent): void => {
      setIsStandalone(e.matches);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    const standaloneMq = window.matchMedia?.('(display-mode: standalone)');
    standaloneMq?.addEventListener?.('change', handleDisplayModeChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      standaloneMq?.removeEventListener?.('change', handleDisplayModeChange);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferredPrompt) return 'unavailable';
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      // beforeinstallprompt event is single-use — clear regardless of outcome.
      setDeferredPrompt(null);
      return choice.outcome;
    } catch {
      setDeferredPrompt(null);
      return 'unavailable';
    }
  }, [deferredPrompt]);

  return { deferredPrompt, isStandalone, isIOS, isInstalled, promptInstall };
}
