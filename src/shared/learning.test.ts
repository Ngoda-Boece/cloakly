import { describe, expect, it } from "vitest";
import { analyzeMessage, LEARNED_REASON, type AnalysisSettings } from "../engine/analysis";
import { ALL_CATEGORIES, type SensitiveEntity } from "../engine/detect";
import { applyCorrections, findCorrections, PROMOTION_THRESHOLD, type Correction } from "./learning";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings";

const person = (value: string, start = 0): SensitiveEntity => ({ type: "PERSON", value, start, end: start + value.length });
const hashed = (correction: Correction) => ({ correction, hash: `${correction.kind}:${correction.value}` });

describe("apprentissage — corrections de la revue", () => {
  it("repère les données décochées et les candidats conservés que l'utilisateur coche", () => {
    const masked = person("Marie Curie");
    const reference: SensitiveEntity = { type: "REFERENCE", value: "INC-4521", start: 20, end: 28, decision: "keep" };
    expect(findCorrections({ entities: [masked], kept: [reference] }, [reference])).toEqual([
      { kind: "unmasked", type: "PERSON", value: "Marie Curie" },
      { kind: "masked", type: "REFERENCE", value: "INC-4521" },
    ]);
    expect(findCorrections({ entities: [masked], kept: [reference] }, [masked])).toEqual([]);
  });

  it("n'apprend jamais des secrets ni des extraits de contexte", () => {
    const secret: SensitiveEntity = { type: "PASSWORD", value: "Soleil!42", start: 0, end: 9 };
    const excerpt: SensitiveEntity = { type: "CONFIDENTIAL", value: "le rachat est prévu", start: 10, end: 29, source: "llm" };
    expect(findCorrections({ entities: [secret, excerpt], kept: [] }, [])).toEqual([]);
  });

  it(`retient une valeur après ${PROMOTION_THRESHOLD} corrections identiques, pas avant`, () => {
    const correction: Correction = { kind: "unmasked", type: "PERSON", value: "Marie Curie" };
    const first = applyCorrections(DEFAULT_SETTINGS, {}, [hashed(correction)]);
    expect(first.settings.allowTerms).toEqual([]);
    expect(first.promoted).toEqual([]);

    const second = applyCorrections(first.settings, first.pending, [hashed(correction)]);
    expect(second.settings.allowTerms).toEqual(["Marie Curie"]);
    expect(second.promoted).toEqual([correction]);
    expect(second.pending).toEqual({});
  });

  it("une donnée cochée deux fois devient un terme confidentiel", () => {
    const correction: Correction = { kind: "masked", type: "REFERENCE", value: "Projet Atlas" };
    const once = applyCorrections(DEFAULT_SETTINGS, {}, [hashed(correction)]);
    expect(applyCorrections(once.settings, once.pending, [hashed(correction)]).settings.customTerms).toEqual(["Projet Atlas"]);
  });

  it("oublie aussitôt une valeur apprise que l'utilisateur coche de nouveau", () => {
    const settings = { ...DEFAULT_SETTINGS, allowTerms: ["Marie Curie"] };
    const result = applyCorrections(settings, {}, [hashed({ kind: "masked", type: "PERSON", value: "marie curie" })]);
    expect(result.settings.allowTerms).toEqual([]);
  });

  it("remet le compteur à zéro quand l'utilisateur change d'avis", () => {
    const unmasked: Correction = { kind: "unmasked", type: "PERSON", value: "Léa" };
    const first = applyCorrections(DEFAULT_SETTINGS, {}, [{ correction: unmasked, hash: "h" }]);
    const flipped = applyCorrections(first.settings, first.pending, [{ correction: { ...unmasked, kind: "masked" }, hash: "h" }]);
    expect(flipped.pending.h).toMatchObject({ kind: "masked", count: 1 });
  });
});

describe("apprentissage — moteur", () => {
  const text = "Quel rôle a joué Jeanne Martin dans ce projet ? Mon mot de passe est Soleil!42";
  const settings = (overrides: Partial<AnalysisSettings> = {}): AnalysisSettings => ({
    categories: ALL_CATEGORIES,
    customTerms: [],
    level: "balanced",
    ...overrides,
  });

  it("propose décochée une valeur apprise, avec son motif", () => {
    const before = analyzeMessage(text, settings(), null);
    expect(before.entities.map((entity) => entity.value)).toContain("Jeanne Martin");

    const after = analyzeMessage(text, settings({ allowTerms: ["jeanne martin"] }), null);
    expect(after.entities.map((entity) => entity.value)).not.toContain("Jeanne Martin");
    expect(after.kept).toContainEqual(expect.objectContaining({ value: "Jeanne Martin", decision: "keep", reason: LEARNED_REASON }));
  });

  it("ignore les valeurs apprises en niveau maximal et pour les secrets", () => {
    const maximum = analyzeMessage(text, settings({ level: "maximum", allowTerms: ["Jeanne Martin"] }), null);
    expect(maximum.entities.map((entity) => entity.value)).toContain("Jeanne Martin");

    const secret = analyzeMessage(text, settings({ allowTerms: ["Soleil!42"] }), null);
    expect(secret.entities.map((entity) => entity.value)).toContain("Soleil!42");
  });

  it("valide les nouveaux réglages venant du stockage", () => {
    expect(normalizeSettings({ allowTerms: [" Léa ", "Léa", 3, "x"], learning: "oui" })).toMatchObject({
      allowTerms: ["Léa"],
      learning: true,
    });
    expect(normalizeSettings({ learning: false }).learning).toBe(false);
  });
});
