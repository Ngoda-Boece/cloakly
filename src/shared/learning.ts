import { entityKey } from "../engine/anonymize";
import { fold } from "../engine/context";
import { SECRET_TYPES, type EntityType, type SensitiveEntity } from "../engine/detect";
import { loadSettings, saveSettings, type Settings } from "./settings";

/**
 * Apprentissage local à partir de la revue. Une valeur décochée (ou cochée)
 * deux fois de la même façon est retenue : ajoutée aux valeurs conservées
 * (`allowTerms`) ou aux termes confidentiels (`customTerms`). Rien ne quitte
 * l'appareil. Tant qu'elle n'est pas retenue, une valeur n'est stockée que
 * sous forme d'empreinte.
 */

export type Correction = {
  /** « unmasked » : proposé masqué puis décoché ; « masked » : proposé conservé puis coché. */
  kind: "unmasked" | "masked";
  type: EntityType;
  value: string;
};

export const PROMOTION_THRESHOLD = 2;
const MAX_PENDING = 500;
const MAX_VALUE_LENGTH = 80;
const LEARNING_KEY = "learning";

type Pending = Record<string, { kind: Correction["kind"]; count: number; at: number }>;

/** Écarts entre la proposition du moteur et le choix final de l'utilisateur dans la revue. */
export function findCorrections(
  proposed: { entities: readonly SensitiveEntity[]; kept: readonly SensitiveEntity[] },
  selected: readonly SensitiveEntity[]
): Correction[] {
  const chosen = new Set(selected.map(entityKey));
  const seen = new Set<string>();
  const corrections: Correction[] = [];
  const add = (entity: SensitiveEntity, kind: Correction["kind"]) => {
    const key = entityKey(entity);
    // Secrets verrouillés, extraits de contexte (phrases entières) : rien à apprendre.
    if (seen.has(key) || SECRET_TYPES.has(entity.type) || entity.type === "CONFIDENTIAL") return;
    if (entity.value.trim().length < 2 || entity.value.length > MAX_VALUE_LENGTH) return;
    seen.add(key);
    corrections.push({ kind, type: entity.type, value: entity.value.trim() });
  };
  for (const entity of proposed.entities) if (!chosen.has(entityKey(entity))) add(entity, "unmasked");
  for (const entity of proposed.kept) if (chosen.has(entityKey(entity))) add(entity, "masked");
  return corrections;
}

/**
 * Applique des corrections à l'état d'apprentissage et aux réglages (fonction pure).
 * Cocher une valeur apprise comme « conservée » l'oublie aussitôt : le doute profite à la protection.
 */
export function applyCorrections(
  settings: Settings,
  pending: Pending,
  corrections: readonly { correction: Correction; hash: string }[],
  now = Date.now()
): { settings: Settings; pending: Pending; promoted: Correction[] } {
  let allowTerms = [...settings.allowTerms];
  let customTerms = [...settings.customTerms];
  const next: Pending = { ...pending };
  const promoted: Correction[] = [];
  const same = (a: string, b: string) => fold(a) === fold(b);

  for (const { correction, hash } of corrections) {
    if (correction.kind === "masked" && allowTerms.some((term) => same(term, correction.value))) {
      allowTerms = allowTerms.filter((term) => !same(term, correction.value));
      delete next[hash];
      continue;
    }
    const entry = next[hash]?.kind === correction.kind ? next[hash] : { kind: correction.kind, count: 0, at: now };
    next[hash] = { kind: correction.kind, count: entry.count + 1, at: now };
    if (next[hash].count < PROMOTION_THRESHOLD) continue;

    delete next[hash];
    promoted.push(correction);
    if (correction.kind === "unmasked") {
      customTerms = customTerms.filter((term) => !same(term, correction.value));
      if (!allowTerms.some((term) => same(term, correction.value))) allowTerms.push(correction.value);
    } else if (!customTerms.some((term) => same(term, correction.value))) {
      customTerms.push(correction.value);
    }
  }

  // Plafond : on oublie les empreintes les plus anciennes.
  const entries = Object.entries(next).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_PENDING);
  return { settings: { ...settings, allowTerms, customTerms }, pending: Object.fromEntries(entries), promoted };
}

async function fingerprint(correction: Correction): Promise<string> {
  const data = new TextEncoder().encode(`${correction.kind}:${correction.type}:${fold(correction.value)}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storage(): chrome.storage.StorageArea | null {
  return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
}

let queue: Promise<unknown> = Promise.resolve();

/** Enregistre les corrections d'une revue ; renvoie les valeurs retenues. Écritures sérialisées. */
export function recordCorrections(corrections: readonly Correction[]): Promise<Correction[]> {
  const area = storage();
  if (!area || corrections.length === 0) return Promise.resolve([]);
  const run = queue.then(async () => {
    const settings = await loadSettings();
    if (!settings.learning) return [];
    const hashed = await Promise.all(corrections.map(async (correction) => ({ correction, hash: await fingerprint(correction) })));
    const pending = ((await area.get(LEARNING_KEY))[LEARNING_KEY] as Pending | undefined) ?? {};
    const result = applyCorrections(settings, pending, hashed);
    await area.set({ [LEARNING_KEY]: result.pending });
    const terms = (value: Settings) => JSON.stringify([value.allowTerms, value.customTerms]);
    if (terms(result.settings) !== terms(settings)) {
      await saveSettings(result.settings);
    }
    return result.promoted;
  });
  queue = run.catch(() => {});
  return run.catch(() => []);
}

/** Oublie tout ce qui a été appris (empreintes et valeurs conservées). */
export async function resetLearning(settings: Settings): Promise<Settings> {
  await storage()?.remove(LEARNING_KEY);
  const next = { ...settings, allowTerms: [] };
  await saveSettings(next);
  return next;
}
