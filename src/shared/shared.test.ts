import { describe, expect, it } from "vitest";
import manifest from "../../public/manifest.json";
import packageJson from "../../package.json";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings";
import { findSiteForHost, findSiteForUrl, manifestMatches } from "./sites";

describe("sites pris en charge", () => {
  it("correspondent exactement aux content_scripts du manifest", () => {
    expect([...manifest.content_scripts[0].matches].sort()).toEqual(manifestMatches().sort());
  });

  it("ont la même version dans le manifest et package.json", () => {
    expect(manifest.version).toBe(packageJson.version);
  });

  it("sont reconnus par nom d'hôte ou URL https uniquement", () => {
    expect(findSiteForHost("chatgpt.com")?.id).toBe("chatgpt");
    expect(findSiteForUrl("https://claude.ai/new")?.id).toBe("claude");
    expect(findSiteForUrl("http://claude.ai/new")).toBeNull();
    expect(findSiteForUrl("https://evil-claude.ai/")).toBeNull();
    expect(findSiteForUrl("chrome://extensions")).toBeNull();
    expect(findSiteForUrl(undefined)).toBeNull();
  });
});

describe("normalizeSettings", () => {
  it("retombe sur les valeurs par défaut (protection active, mode strict)", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("n'importe quoi")).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({ enabled: true, strictMode: true });
  });

  it("filtre les valeurs invalides", () => {
    expect(
      normalizeSettings({
        enabled: false,
        strictMode: "oui",
        categories: ["secrets", "inconnue", 3],
        customTerms: [" Atlas ", "Atlas", "x", 42, "Client Durand"],
        ai: { ner: true, llm: "oui" },
        theme: "violet",
      })
    ).toEqual({
      enabled: false,
      strictMode: true,
      privacyLevel: "balanced",
      categories: ["secrets"],
      customTerms: ["Atlas", "Client Durand"],
      ai: { ner: true, llm: false, locations: false },
      theme: "light",
    });
  });

  it("conserve le thème sombre choisi", () => {
    expect(normalizeSettings({ theme: "dark" }).theme).toBe("dark");
  });

  it("garde l'IA désactivée par défaut (téléchargement soumis à consentement)", () => {
    expect(normalizeSettings({}).ai).toEqual({ ner: false, llm: false, locations: false });
  });
});
