import { ALL_CATEGORIES, type CategoryId, type PrivacyLevel } from "../engine/detect";

export type AiSettings = {
  /** Modèle NER : personnes, organisations (et lieux si `locations`). */
  ner: boolean;
  /** Mini-LLM : analyse du contexte des messages longs. */
  llm: boolean;
  /** Masquer aussi les lieux (désactivé par défaut : souvent anodins). */
  locations: boolean;
};

export type Theme = "light" | "dark";

export type Settings = {
  enabled: boolean;
  strictMode: boolean;
  /** Équilibré : garde ce qui sert la tâche (n° de commande, IP privée…). Maximal : masque aussi ces éléments. */
  privacyLevel: PrivacyLevel;
  categories: CategoryId[];
  customTerms: string[];
  ai: AiSettings;
  /** Thème du popup et des boîtes affichées sur les sites. */
  theme: Theme;
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  strictMode: true,
  privacyLevel: "balanced",
  categories: [...ALL_CATEGORIES],
  customTerms: [],
  // Désactivée tant que l'utilisateur n'a pas accepté le téléchargement des modèles.
  ai: { ner: false, llm: false, locations: false },
  theme: "light",
};

const STORAGE_KEY = "settings";

/** Valide des réglages venant du stockage ; toute valeur invalide reprend sa valeur par défaut. */
export function normalizeSettings(raw: unknown): Settings {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const ai = (value.ai && typeof value.ai === "object" ? value.ai : {}) as Partial<Record<keyof AiSettings, unknown>>;
  const flag = (input: unknown, fallback: boolean) => (typeof input === "boolean" ? input : fallback);

  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.enabled,
    strictMode:
      typeof value.strictMode === "boolean" ? value.strictMode : DEFAULT_SETTINGS.strictMode,
    privacyLevel: value.privacyLevel === "maximum" ? "maximum" : DEFAULT_SETTINGS.privacyLevel,
    categories: Array.isArray(value.categories)
      ? ALL_CATEGORIES.filter((category) => (value.categories as unknown[]).includes(category))
      : [...DEFAULT_SETTINGS.categories],
    customTerms: Array.isArray(value.customTerms)
      ? [
          ...new Set(
            value.customTerms
              .filter((term): term is string => typeof term === "string")
              .map((term) => term.trim())
              .filter((term) => term.length >= 2)
          ),
        ]
      : [],
    ai: {
      ner: flag(ai.ner, DEFAULT_SETTINGS.ai.ner),
      llm: flag(ai.llm, DEFAULT_SETTINGS.ai.llm),
      locations: flag(ai.locations, DEFAULT_SETTINGS.ai.locations),
    },
    theme: value.theme === "dark" ? "dark" : DEFAULT_SETTINGS.theme,
  };
}

function chromeStorage(): chrome.storage.StorageArea | null {
  return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
}

export async function loadSettings(): Promise<Settings> {
  const storage = chromeStorage();
  if (storage) {
    const stored = await storage.get(STORAGE_KEY);
    return normalizeSettings(stored[STORAGE_KEY]);
  }

  // Hors extension (npm run dev), on retombe sur localStorage.
  const raw = localStorage.getItem(STORAGE_KEY);
  return normalizeSettings(raw ? JSON.parse(raw) : undefined);
}

export async function saveSettings(settings: Settings): Promise<void> {
  const normalized = normalizeSettings(settings);
  const storage = chromeStorage();

  if (storage) {
    await storage.set({ [STORAGE_KEY]: normalized });
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }
}

export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return () => {};

  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ) => {
    if (areaName === "local" && STORAGE_KEY in changes) {
      listener(normalizeSettings(changes[STORAGE_KEY].newValue));
    }
  };

  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
