import { useCallback, useEffect, useState } from 'react';
import brand from '../config/brand';

const STORAGE_KEY = brand.themeStorageKey || 'lg-theme';

export function getInitialTheme() {
  if (typeof window === 'undefined') return 'dark';
  return localStorage.getItem(STORAGE_KEY) || 'dark';
}

export function useTheme() {
  const [theme, setThemeState] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const setTheme = useCallback((value) => {
    setThemeState(value === 'light' ? 'light' : 'dark');
  }, []);

  return { theme, toggleTheme, setTheme, isDark: theme === 'dark' };
}
