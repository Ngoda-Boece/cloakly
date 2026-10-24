import { describe, expect, it } from "vitest";
import { analyzeMessage, type AnalysisSettings } from "../analysis";
import { createAliasRegistry } from "../anonymize";
import { ALL_CATEGORIES, type PrivacyLevel } from "../detect";
import { protect } from "../protect";
import { CORPUS } from "./corpus";
import { HOLDOUT } from "./holdout";
import { evaluate, formatReport, type Engine } from "./metrics";

function engine(level: PrivacyLevel): Engine {
  const settings: AnalysisSettings = { categories: ALL_CATEGORIES, customTerms: [], level };
  return (text) => {
    const { entities, kept } = analyzeMessage(text, settings, null);
    const protection = protect(text, entities, settings, createAliasRegistry(), kept);
    // Un envoi non vérifié est bloqué : rien ne part.
    return {
      sanitized: protection.verified ? protection.sanitized : "",
      masked: protection.spans.map(({ start, end }) => ({ start, end })),
    };
  };
}

/**
 * Objectifs mesurés sur des données synthétiques. Ce sont des garde-fous de
 * non-régression, pas une preuve de sécurité : le jeu ne couvre pas tous les cas.
 */
describe("métriques — jeu de référence", () => {
  const metrics = evaluate(CORPUS, engine("balanced"));

  it("ne transmet aucune donnée annotée, et aucun secret", () => {
    expect(metrics.leaks, formatReport(metrics)).toBe(0);
    expect(metrics.secretsTransmitted).toBe(0);
    expect(metrics.byGroup.secret.recall).toBe(1);
    expect(metrics.byGroup.sensitive.recall).toBe(1);
  });

  it("conserve l'intention et les paramètres utiles", () => {
    expect(metrics.intentPreservation, formatReport(metrics)).toBe(1);
    expect(metrics.parameterPreservation).toBeGreaterThanOrEqual(0.98);
    expect(metrics.incomprehensibleRate).toBe(0);
  });

  it("garde un taux de faux positifs faible et ne modifie pas les messages sans donnée", () => {
    expect(metrics.precision, formatReport(metrics)).toBeGreaterThanOrEqual(0.95);
    expect(metrics.cleanPromptsAltered).toBe(0);
  });

  it("reste rapide (règles seules)", () => {
    expect(metrics.latency.p95Ms).toBeLessThan(100);
  });
});

describe("métriques — jeu de contrôle (non utilisé pour régler le moteur)", () => {
  const metrics = evaluate(HOLDOUT, engine("balanced"));

  it("ne transmet aucun secret ni donnée sensible annotée", () => {
    expect(metrics.secretsTransmitted, formatReport(metrics, "contrôle")).toBe(0);
    expect(metrics.byGroup.sensitive.recall).toBe(1);
  });

  it("conserve l'intention ; seuils de détection plus prudents qu'en référence", () => {
    expect(metrics.intentPreservation, formatReport(metrics, "contrôle")).toBe(1);
    expect(metrics.recall).toBeGreaterThanOrEqual(0.9);
    expect(metrics.precision).toBeGreaterThanOrEqual(0.9);
  });
});

describe("métriques — niveau maximal", () => {
  it("masque davantage, au prix connu des questions sur une personnalité publique", () => {
    const balanced = evaluate(CORPUS, engine("balanced"));
    const maximum = evaluate(CORPUS, engine("maximum"));
    expect(maximum.leaks).toBe(0);
    // Les références de commande, IP privées et adresses d'itinéraire sont alors masquées.
    expect(maximum.parameterPreservation).toBeLessThan(balanced.parameterPreservation);
    // Compromis assumé du niveau maximal : « Résume la vie de Victor Hugo » perd son sujet.
    const degraded = maximum.results.filter((result) => result.lostIntent.length > 0).map((result) => result.id);
    expect(degraded).toEqual(["clean-public-figure"]);
  });
});
