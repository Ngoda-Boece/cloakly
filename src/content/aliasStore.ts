import { createAliasRegistry, serializeRegistry, type AliasEntry, type AliasRegistry } from "../engine/anonymize";

// storage.session : en mémoire, effacé à la fermeture du navigateur.
const keyFor = (host: string) => `aliases:${host}`;

export async function loadAliases(host: string): Promise<AliasRegistry> {
  try {
    const stored = (await chrome.storage.session.get(keyFor(host)))[keyFor(host)];
    return createAliasRegistry(Array.isArray(stored) ? (stored as [string, AliasEntry][]) : []);
  } catch {
    return createAliasRegistry();
  }
}

export async function saveAliases(host: string, registry: AliasRegistry): Promise<void> {
  try {
    await chrome.storage.session.set({ [keyFor(host)]: serializeRegistry(registry) });
  } catch {
    // Persistance de confort : la pseudonymisation reste cohérente dans l'onglet.
  }
}
