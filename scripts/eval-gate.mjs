// Porte qualité de la boucle d'amélioration : compare le moteur actuel (src/engine, modifications
// non commitées comprises) au moteur d'un commit de base, sur les jeux référence, contrôle et générés.
// Accepte le changement seulement s'il améliore au moins une métrique sans aucune régression.
// Usage : npm run eval:gate                      (base : HEAD)
//         npm run eval:gate -- --base main
//         npm run eval:gate -- --allow-neutral   (refactorisation : aucune amélioration exigée)
//         npm run eval:gate -- --no-record       (n'écrit ni eval/history.jsonl ni eval/baseline.json)
// Code de sortie : 0 accepté, 1 refusé.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const base = option("--base") ?? "HEAD";
const level = option("--level") ?? "balanced";
const today = new Date();
const daySeed = Number(`${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`);
// Graines fixes (comparables d'un jour à l'autre) + graine du jour (cas inédits).
const seeds = (option("--seeds") ?? `1,2,3,${daySeed}`).split(",").map(Number);
const EPSILON = 1e-9;

const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Extrait src/engine tel qu'il était au commit de base, sans toucher à l'arbre de travail. */
function extractBaseEngine() {
  const dir = mkdtempSync(join(tmpdir(), "cloakly-base-"));
  for (const file of git("ls-tree", "-r", "--name-only", base, "src/engine").split("\n").filter(Boolean)) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git("show", `${base}:${file}`));
  }
  return join(dir, "src/engine");
}

function run(engineDir, set, seed) {
  let output;
  try {
    output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--import",
        "./scripts/register-ts.mjs",
        "scripts/eval-privacy.mjs",
        "--engine",
        engineDir,
        "--level",
        level,
        "--set",
        set,
        ...(seed === undefined ? [] : ["--seed", String(seed)]),
        "--json",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (error) {
    const detail = String(error.stderr ?? error.message).split("\n").find((line) => /Error/.test(line)) ?? "";
    console.log(`REFUSÉ : le moteur ${engineDir} plante sur le jeu ${set}. ${detail.trim()}`);
    process.exit(1);
  }
  return JSON.parse(output);
}

const SUITES = [
  { name: "reference", set: "reference" },
  { name: "holdout", set: "holdout" },
  ...seeds.map((seed) => ({ name: `generated:${seed}`, set: "generated", seed })),
];

// Sens de chaque métrique : +1 plus haut = mieux, -1 plus bas = mieux.
const QUALITY = {
  leaks: -1,
  secretsTransmitted: -1,
  recall: 1,
  precision: 1,
  cleanPromptsAltered: -1,
  parameterPreservation: 1,
  intentPreservation: 1,
  incomprehensibleRate: -1,
};

function compare(suite, before, after) {
  const regressions = [];
  const improvements = [];
  for (const [metric, direction] of Object.entries(QUALITY)) {
    const delta = (after[metric] - before[metric]) * direction;
    if (delta < -EPSILON) regressions.push(`${suite} ${metric} ${before[metric]} → ${after[metric]}`);
    if (delta > EPSILON) improvements.push(`${suite} ${metric} ${before[metric]} → ${after[metric]}`);
  }
  for (const [group, stats] of Object.entries(after.byGroup)) {
    if (stats.recall < before.byGroup[group].recall - EPSILON) {
      regressions.push(`${suite} rappel ${group} ${before.byGroup[group].recall} → ${stats.recall}`);
    }
  }
  return { regressions, improvements };
}

const summary = (metrics) => ({
  cases: metrics.cases,
  ...Object.fromEntries(Object.keys(QUALITY).map((metric) => [metric, metrics[metric]])),
  p95Ms: Number(metrics.latency.p95Ms.toFixed(2)),
});

const baseDir = extractBaseEngine();
const regressions = [];
const improvements = [];
const candidate = {};
const medians = { before: 0, after: 0 };
try {
  for (const suite of SUITES) {
    const before = run(baseDir, suite.set, suite.seed);
    const after = run(resolve("src/engine"), suite.set, suite.seed);
    const result = compare(suite.name, before, after);
    regressions.push(...result.regressions);
    medians.before += before.latency.medianMs;
    medians.after += after.latency.medianMs;
    improvements.push(...result.improvements);
    candidate[suite.name] = summary(after);
  }
} finally {
  rmSync(resolve(baseDir, "../.."), { recursive: true, force: true });
}

// Le p95 d'un petit jeu est trop bruité : on ne bloque qu'un net ralentissement des médianes cumulées.
if (medians.after > medians.before * 1.5 + 2) {
  regressions.push(`latence médiane cumulée ${medians.before.toFixed(2)} → ${medians.after.toFixed(2)} ms`);
}

const accepted = regressions.length === 0 && (improvements.length > 0 || args.includes("--allow-neutral"));
console.log(`== Porte qualité · base ${base} · niveau ${level} · graines ${seeds.join(", ")} ==`);
for (const line of improvements) console.log(`  + ${line}`);
for (const line of regressions) console.log(`  - ${line}`);
if (!improvements.length && !regressions.length) console.log("  (aucun changement mesurable)");
console.log(accepted ? "ACCEPTÉ" : regressions.length ? "REFUSÉ : régression" : "REFUSÉ : aucune amélioration");

if (!args.includes("--no-record")) {
  mkdirSync("eval", { recursive: true });
  const entry = {
    date: today.toISOString(),
    base: git("rev-parse", "--short", base).trim(),
    head: git("rev-parse", "--short", "HEAD").trim(),
    dirty: git("status", "--porcelain", "src/engine").trim().length > 0,
    level,
    seeds,
    decision: accepted ? "accepted" : "rejected",
    improvements,
    regressions,
    metrics: candidate,
  };
  appendFileSync("eval/history.jsonl", `${JSON.stringify(entry)}\n`);
  if (accepted) writeFileSync("eval/baseline.json", `${JSON.stringify({ date: entry.date, level, seeds, metrics: candidate }, null, 2)}\n`);
}

process.exit(accepted ? 0 : 1);
