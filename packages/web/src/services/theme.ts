/**
 * Theme Management Service
 * Handles dark/light theme switching
 */

export type Theme = 'dark' | 'light' | 'system';

interface ThemeConfig {
  current: Theme;
  systemPreference: 'dark' | 'light';
}

class ThemeService {
  private config: ThemeConfig = {
    current: 'dark',
    systemPreference: 'dark',
  };

  private listeners: Set<(theme: 'dark' | 'light') => void> = new Set();
  private mediaQuery: MediaQueryList | null = null;

  constructor() {
    this.loadConfig();
    this.setupSystemPreferenceListener();
    this.applyTheme();
  }

  /**
   * Load theme from localStorage
   */
  private loadConfig(): void {
    const saved = localStorage.getItem('themeConfig');
    if (saved) {
      this.config = JSON.parse(saved);
    } else {
      // Detect system preference
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        this.config.systemPreference = 'light';
      }
    }
  }

  /**
   * Save theme to localStorage
   */
  private saveConfig(): void {
    localStorage.setItem('themeConfig', JSON.stringify(this.config));
  }

  /**
   * Setup listener for system preference changes
   */
  private setupSystemPreferenceListener(): void {
    if (!window.matchMedia) return;

    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.mediaQuery.addEventListener('change', (e) => {
      this.config.systemPreference = e.matches ? 'dark' : 'light';
      if (this.config.current === 'system') {
        this.applyTheme();
        this.notifyListeners();
      }
    });
  }

  /**
   * Get effective theme (considering system preference)
   */
  private getEffectiveTheme(): 'dark' | 'light' {
    if (this.config.current === 'system') {
      return this.config.systemPreference;
    }
    return this.config.current;
  }

  /**
   * Apply theme to document
   */
  private applyTheme(): void {
    const effectiveTheme = this.getEffectiveTheme();
    document.documentElement.setAttribute('data-theme', effectiveTheme);

    if (effectiveTheme === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }
  }

  /**
   * Notify all listeners of theme change
   */
  private notifyListeners(): void {
    const effectiveTheme = this.getEffectiveTheme();
    this.listeners.forEach((listener) => listener(effectiveTheme));
  }

  /**
   * Set theme
   */
  setTheme(theme: Theme): void {
    this.config.current = theme;
    this.saveConfig();
    this.applyTheme();
    this.notifyListeners();
  }

  /**
   * Get current theme setting
   */
  getTheme(): Theme {
    return this.config.current;
  }

  /**
   * Get effective theme
   */
  getEffectiveThemeValue(): 'dark' | 'light' {
    return this.getEffectiveTheme();
  }

  /**
   * Toggle between dark and light
   */
  toggleTheme(): void {
    const newTheme = this.getEffectiveTheme() === 'dark' ? 'light' : 'dark';
    this.setTheme(newTheme);
  }

  /**
   * Subscribe to theme changes
   */
  subscribe(listener: (theme: 'dark' | 'light') => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Get theme colors
   */
  getColors(): Record<string, string> {
    const isDark = this.getEffectiveTheme() === 'dark';
    return {
      background: isDark ? '#0f0f0f' : '#ffffff',
      foreground: isDark ? '#ffffff' : '#000000',
      card: isDark ? '#1a1a1a' : '#f5f5f5',
      primary: isDark ? '#3b82f6' : '#2563eb',
      good: isDark ? '#10b981' : '#059669',
      evil: isDark ? '#ef4444' : '#dc2626',
    };
  }
}

// Singleton instance
const themeService = new ThemeService();
export default themeService;
