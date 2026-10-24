import type { CorpusCase, RiskGroup } from "./corpus";

/**
 * Métriques reproductibles sur le jeu de référence. Le moteur évalué est
 * passé en paramètre : on peut ainsi comparer deux versions du moteur.
 */

export type EngineRun = {
  /** Texte qui serait transmis au fournisseur. */
  sanitized: string;
  /** Passages masqués, positions dans le texte d'origine. */
  masked: { start: number; end: number }[];
};

export type Engine = (text: string) => EngineRun;

export type CaseResult = {
  id: string;
  category: string;
  leaks: { value: string; group: RiskGroup }[];
  falsePositives: string[];
  lostParameters: string[];
  lostIntent: string[];
  incomprehensible: boolean;
  latencyMs: number;
};

export type GroupStats = { annotated: number; protected: number; recall: number };

export type Metrics = {
  cases: number;
  precision: number;
  recall: number;
  /** Part des passages masqués qui ne correspondaient à aucune donnée annotée. */
  falsePositiveRate: number;
  falseNegativeRate: number;
  /** Messages sans donnée annotée mais modifiés quand même. */
  cleanPromptsAltered: number;
  intentPreservation: number;
  parameterPreservation: number;
  incomprehensibleRate: number;
  latency: { medianMs: number; p95Ms: number; maxMs: number };
  /** Données annotées encore présentes dans le texte transmis. */
  leaks: number;
  secretsTransmitted: number;
  byGroup: Record<RiskGroup, GroupStats>;
  byCategory: Record<string, { cases: number; leaks: number; falsePositives: number; lostParameters: number; lostIntent: number }>;
  results: CaseResult[];
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWord(value: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, "gu");
}

function occurrences(text: string, value: string): { start: number; end: number }[] {
  return [...text.matchAll(wholeWord(value))].map((match) => ({ start: match.index, end: match.index + value.length }));
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

const ratio = (part: number, total: number) => (total === 0 ? 1 : part / total);

export function evaluate(corpus: readonly CorpusCase[], engine: Engine): Metrics {
  const results: CaseResult[] = [];
  let truePositives = 0;
  let falsePositiveSpans = 0;
  let annotated = 0;
  let protectedCount = 0;
  let keepTotal = 0;
  let keepPreserved = 0;
  let intentKept = 0;
  let cleanCases = 0;
  let cleanAltered = 0;
  const byGroup = Object.fromEntries(
    (["direct", "sensitive", "secret", "business"] as RiskGroup[]).map((group) => [group, { annotated: 0, protected: 0, recall: 1 }])
  ) as Record<RiskGroup, GroupStats>;

  for (const item of corpus) {
    const started = performance.now();
    const run = engine(item.text);
    const latencyMs = performance.now() - started;

    // Fuites : une valeur annotée encore présente telle quelle dans le texte transmis.
    const leaks = item.mask.filter((annotation) => wholeWord(annotation.value).test(run.sanitized));
    for (const annotation of item.mask) {
      annotated += 1;
      byGroup[annotation.group].annotated += 1;
      if (!leaks.includes(annotation)) {
        protectedCount += 1;
        byGroup[annotation.group].protected += 1;
      }
    }

    // Passages masqués sans rapport avec une donnée annotée : faux positifs.
    const annotatedSpans = item.mask.flatMap((annotation) => occurrences(item.text, annotation.value));
    const falsePositives: string[] = [];
    for (const span of run.masked) {
      if (annotatedSpans.some((other) => span.start < other.end && other.start < span.end)) truePositives += 1;
      else {
        falsePositiveSpans += 1;
        falsePositives.push(item.text.slice(span.start, span.end));
      }
    }

    const lostParameters = item.keep.filter((value) => !run.sanitized.includes(value));
    keepTotal += item.keep.length;
    keepPreserved += item.keep.length - lostParameters.length;

    const lostIntent = item.intent.filter((value) => !run.sanitized.includes(value));
    if (lostIntent.length === 0) intentKept += 1;

    const visible = item.text.replace(/\s+/g, "").length;
    const hidden = run.masked.reduce((total, span) => total + item.text.slice(span.start, span.end).replace(/\s+/g, "").length, 0);
    const remainingWords = run.sanitized.replace(/\[[A-Z_]+_\d+\]/g, " ").match(/\p{L}{2,}/gu)?.length ?? 0;
    const incomprehensible =
      lostIntent.length > 0 || (visible >= 30 && ((hidden / visible > 0.8 && remainingWords < 2) || remainingWords === 0));

    if (item.mask.length === 0) {
      cleanCases += 1;
      if (run.sanitized !== item.text) cleanAltered += 1;
    }

    results.push({ id: item.id, category: item.category, leaks, falsePositives, lostParameters, lostIntent, incomprehensible, latencyMs });
  }

  for (const stats of Object.values(byGroup)) stats.recall = ratio(stats.protected, stats.annotated);

  const byCategory: Metrics["byCategory"] = {};
  for (const result of results) {
    const entry = (byCategory[result.category] ??= { cases: 0, leaks: 0, falsePositives: 0, lostParameters: 0, lostIntent: 0 });
    entry.cases += 1;
    entry.leaks += result.leaks.length;
    entry.falsePositives += result.falsePositives.length;
    entry.lostParameters += result.lostParameters.length;
    entry.lostIntent += result.lostIntent.length;
  }

  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const precision = ratio(truePositives, truePositives + falsePositiveSpans);
  const recall = ratio(protectedCount, annotated);

  return {
    cases: corpus.length,
    precision,
    recall,
    falsePositiveRate: 1 - precision,
    falseNegativeRate: 1 - recall,
    cleanPromptsAltered: ratio(cleanAltered, cleanCases),
    intentPreservation: ratio(intentKept, corpus.length),
    parameterPreservation: ratio(keepPreserved, keepTotal),
    incomprehensibleRate: ratio(results.filter((result) => result.incomprehensible).length, corpus.length),
    latency: { medianMs: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), maxMs: latencies.at(-1) ?? 0 },
    leaks: annotated - protectedCount,
    secretsTransmitted: byGroup.secret.annotated - byGroup.secret.protected,
    byGroup,
    byCategory,
    results,
  };
}

const percent = (value: number) => `${(value * 100).toFixed(1)} %`;

/** Rapport texte lisible (script d'évaluation, sortie de test). */
export function formatReport(metrics: Metrics, title = "Évaluation"): string {
  const lines = [
    `== ${title} (${metrics.cases} messages) ==`,
    `Précision de détection ......... ${percent(metrics.precision)}`,
    `Rappel de détection ............ ${percent(metrics.recall)}`,
    `Taux de faux positifs .......... ${percent(metrics.falsePositiveRate)}`,
    `Taux de faux négatifs .......... ${percent(metrics.falseNegativeRate)}`,
    `Messages sans donnée modifiés .. ${percent(metrics.cleanPromptsAltered)}`,
    `Intention conservée ............ ${percent(metrics.intentPreservation)}`,
    `Paramètres utiles conservés .... ${percent(metrics.parameterPreservation)}`,
    `Messages rendus incompréhensibles ${percent(metrics.incomprehensibleRate)}`,
    `Latence (médiane / p95 / max) .. ${metrics.latency.medianMs.toFixed(2)} / ${metrics.latency.p95Ms.toFixed(2)} / ${metrics.latency.maxMs.toFixed(2)} ms`,
    `Fuites (données annotées transmises) ${metrics.leaks}, dont secrets : ${metrics.secretsTransmitted}`,
    "",
    "Rappel par groupe de risque :",
    ...Object.entries(metrics.byGroup).map(
      ([group, stats]) => `  ${group.padEnd(10)} ${stats.protected}/${stats.annotated} (${percent(stats.recall)})`
    ),
    "",
    "Par catégorie (fuites / faux positifs / paramètres perdus / intention perdue) :",
    ...Object.entries(metrics.byCategory).map(
      ([category, stats]) =>
        `  ${category.padEnd(26)} ${stats.leaks} / ${stats.falsePositives} / ${stats.lostParameters} / ${stats.lostIntent}  (${stats.cases} cas)`
    ),
  ];
  const problems = metrics.results.filter(
    (result) => result.leaks.length || result.falsePositives.length || result.lostParameters.length || result.lostIntent.length
  );
  if (problems.length) {
    lines.push("", "Détail des écarts :");
    for (const result of problems) {
      const parts = [
        result.leaks.length && `fuite ${result.leaks.map((leak) => `[${leak.group}]`).join("")}`,
        result.falsePositives.length && `faux positif « ${result.falsePositives.join(" », « ")} »`,
        result.lostParameters.length && `paramètre perdu « ${result.lostParameters.join(" », « ")} »`,
        result.lostIntent.length && `intention perdue « ${result.lostIntent.join(" », « ")} »`,
      ].filter(Boolean);
      lines.push(`  ${result.id}: ${parts.join(" ; ")}`);
    }
  }
  return lines.join("\n");
}
