import type { Theme } from "./shared/settings";

/** Copie locale du thème : appliquée avant le rendu pour éviter un flash clair à l'ouverture du popup. */
const CACHE_KEY = "cloakly-theme";

export function applyDocumentTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // Stockage indisponible : le thème sera repris depuis les réglages.
  }
}

export function applyCachedTheme(): void {
  try {
    if (localStorage.getItem(CACHE_KEY) === "dark") document.documentElement.dataset.theme = "dark";
  } catch {
    // Idem.
  }
}
