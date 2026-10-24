// Mesure la protection et la préservation de la tâche sur le jeu de référence synthétique.
// Usage : npm run eval:privacy                       (moteur actuel, niveau équilibré)
//         npm run eval:privacy -- --level maximum
//         npm run eval:privacy -- --engine <dossier>  (autre version du moteur, pour comparer)
//         npm run eval:privacy -- --set holdout      (jeu de contrôle, jamais utilisé pour régler le moteur)
//         npm run eval:privacy -- --set generated --seed 42 --count 99  (cas synthétiques inédits)
//         npm run eval:privacy -- --failures tmp/failures.json        (écarts groupés par catégorie)
//         npm run eval:privacy -- --json             (sortie machine)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CORPUS } from "../src/engine/eval/corpus.ts";
import { generateCases } from "../src/engine/eval/generator.ts";
import { HOLDOUT } from "../src/engine/eval/holdout.ts";
import { evaluate, formatReport } from "../src/engine/eval/metrics.ts";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const engineDir = resolve(option("--engine") ?? "src/engine");
const level = option("--level") ?? "balanced";
const set = option("--set") ?? "reference";
const seed = Number(option("--seed") ?? 1);
const count = option("--count") ? Number(option("--count")) : undefined;
const SETS = {
  reference: () => CORPUS,
  holdout: () => HOLDOUT,
  generated: () => generateCases(seed, count),
  all: () => [...CORPUS, ...HOLDOUT],
};
if (!SETS[set]) throw new Error(`Jeu inconnu : ${set} (${Object.keys(SETS).join(", ")})`);
const cases = SETS[set]();
const setLabel = set === "generated" ? `generated (graine ${seed})` : set;
const load = (file) => import(pathToFileURL(resolve(engineDir, file)).href);

const analysis = await load("analysis.ts");
const anonymize = await load("anonymize.ts");
const protectModule = await load("protect.ts");

// Toutes les catégories des règles, sans IA : c'est ce qui tourne quand les modèles sont désactivés (défaut).
const settings = {
  categories: ["personal", "professional", "secrets", "confidential", "identities", "context"],
  customTerms: [],
  level,
};

function engine(text) {
  if (analysis.analyzeMessage && protectModule.protect) {
    // Chaîne complète : détection, revue (tout accepté), pseudonymisation, validation.
    const { entities, kept } = analysis.analyzeMessage(text, settings, null);
    const protection = protectModule.protect(text, entities, settings, anonymize.createAliasRegistry(), kept);
    return {
      sanitized: protection.verified ? protection.sanitized : "",
      masked: protection.spans.map(({ start, end }) => ({ start, end })),
    };
  }
  // Ancienne version du moteur : même parcours avec son API d'origine.
  const entities = analysis.combineDetections(text, settings, null);
  return {
    sanitized: anonymize.anonymizeText(text, entities).text,
    masked: entities.map(({ start, end }) => ({ start, end })),
  };
}

// Échauffement (compilation des expressions régulières) hors mesure de latence.
for (const item of cases.slice(0, 5)) engine(item.text);
const metrics = evaluate(cases, engine);

const failuresFile = option("--failures");
if (failuresFile) {
  // Écarts seulement, avec le texte du cas : de quoi diagnostiquer sans relancer l'évaluation.
  const texts = new Map(cases.map((item) => [item.id, item.text]));
  const failures = {};
  for (const result of metrics.results) {
    if (!(result.leaks.length || result.falsePositives.length || result.lostParameters.length || result.lostIntent.length)) continue;
    const { latencyMs: _latency, incomprehensible: _incomprehensible, ...detail } = result;
    (failures[result.category] ??= []).push({ ...detail, text: texts.get(result.id) });
  }
  mkdirSync(dirname(resolve(failuresFile)), { recursive: true });
  writeFileSync(resolve(failuresFile), JSON.stringify({ set: setLabel, level, failures }, null, 2));
}

if (args.includes("--json")) {
  const { results: _results, ...summary } = metrics;
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(formatReport(metrics, `Moteur ${option("--engine") ? engineDir : "actuel"} · niveau ${level} · jeu ${setLabel}`));
}
