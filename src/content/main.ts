import { analyzeWithAi, loadModels } from "../ai/client";
import { createAliasRegistry } from "../engine/anonymize";
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from "../shared/settings";
import { findSiteForHost } from "../shared/sites";
import { recordStats } from "../shared/stats";
import { loadAliases, saveAliases } from "./aliasStore";
import { installInterceptor } from "./interceptor";
import { createAliasPanel } from "./panel";

const site = findSiteForHost(location.hostname);

if (site) {
  // Tant que les réglages ne sont pas chargés, on applique les valeurs par
  // défaut (protection active, mode strict) plutôt que de laisser passer.
  let settings: Settings = DEFAULT_SETTINGS;
  const host = location.hostname;

  const warmUp = (next: Settings) => {
    // Précharge les modèles activés pour que le premier envoi ne les attende pas.
    if (next.enabled && (next.ai.ner || next.ai.llm)) {
      loadModels({ ner: next.ai.ner, llm: next.ai.llm }).catch(() => {});
    }
  };

  loadSettings()
    .then((loaded) => {
      settings = loaded;
      warmUp(loaded);
    })
    .catch((error: unknown) => {
      console.error("[Cloakly] Impossible de charger les réglages :", error);
    });

  onSettingsChanged((next) => {
    settings = next;
    warmUp(next);
  });

  // L'intercepteur est installé tout de suite (content script en document_start) :
  // aucun envoi ne doit échapper à l'analyse pendant le chargement des alias.
  const aliases = createAliasRegistry();
  let panel: ReturnType<typeof createAliasPanel> | null = null;

  installInterceptor({
    doc: document,
    site,
    getSettings: () => settings,
    aliases,
    analyzeAi: analyzeWithAi,
    onAliasesChanged: (registry) => {
      void saveAliases(host, registry);
      panel?.refresh();
    },
    onStats: (delta) => void recordStats(delta),
  });

  void loadAliases(host).then((stored) => {
    // Les alias attribués entre-temps restent prioritaires.
    for (const [key, entry] of stored) if (!aliases.has(key)) aliases.set(key, entry);
    const showPanel = () => {
      panel = createAliasPanel(document, aliases, () => {
        aliases.clear();
        void saveAliases(host, aliases);
      });
      panel.refresh();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showPanel, { once: true });
    else showPanel();
  });
}
