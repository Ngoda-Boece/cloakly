export type Stats = {
  /** Messages analysés avant envoi. */
  analyzed: number;
  /** Messages envoyés après pseudonymisation vérifiée. */
  protected: number;
  /** Données sensibles remplacées. */
  masked: number;
  /** Envois bloqués (mode strict ou annulation). */
  blocked: number;
};

const STATS_KEY = "stats";
export const EMPTY_STATS: Stats = { analyzed: 0, protected: 0, masked: 0, blocked: 0 };

function storage(): chrome.storage.StorageArea | null {
  return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
}

export async function loadStats(): Promise<Stats> {
  const area = storage();
  if (!area) return EMPTY_STATS;
  const stored = (await area.get(STATS_KEY))[STATS_KEY] as Partial<Stats> | undefined;
  return { ...EMPTY_STATS, ...stored };
}

let queue: Promise<void> = Promise.resolve();

/** Incrémente les compteurs locaux (jamais transmis). Les écritures sont sérialisées. */
export function recordStats(delta: Partial<Stats>): Promise<void> {
  const area = storage();
  if (!area) return Promise.resolve();
  queue = queue
    .then(async () => {
      const current = await loadStats();
      const next = { ...current };
      for (const key of Object.keys(delta) as (keyof Stats)[]) next[key] += delta[key] ?? 0;
      await area.set({ [STATS_KEY]: next });
    })
    .catch(() => {});
  return queue;
}

export async function resetStats(): Promise<void> {
  await storage()?.set({ [STATS_KEY]: EMPTY_STATS });
}
