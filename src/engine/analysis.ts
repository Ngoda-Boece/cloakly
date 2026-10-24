import type { AliasRegistry } from "./anonymize";
import {
  classifySensitiveData,
  ENTITY_CATEGORY,
  mergeEntities,
  SECRET_TYPES,
  type CategoryId,
  type PrivacyLevel,
  type SensitiveEntity,
} from "./detect";
import { fold } from "./context";
import type { ContextVerdict } from "./llmPrompt";
import { analyzeTask, protectedParameters, type TaskProfile } from "./task";

export type AnalysisSettings = {
  categories: readonly CategoryId[];
  customTerms: readonly string[];
  level?: PrivacyLevel;
  /** Valeurs que l'utilisateur a décochées plusieurs fois : proposées décochées (jamais un secret, ignorées en niveau maximal). */
  allowTerms?: readonly string[];
};

/** Résultat brut des modèles IA, tel que renvoyé par le document offscreen. */
export type AiFindings = {
  ner: SensitiveEntity[] | null;
  verdict: ContextVerdict | null;
  timings: { nerMs?: number; llmMs?: number };
};

export type AnalysisReport = {
  entities: SensitiveEntity[];
  verdict: ContextVerdict | null;
  /** Moteurs ayant effectivement analysé le message. */
  engines: ("rules" | "ner" | "llm")[];
  durationMs: number;
};

/** En dessous, un message est trop court pour que l'analyse de contexte soit utile. */
export const MIN_CONTEXT_CHARS = 40;

export function needsContextAnalysis(text: string): boolean {
  return text.trim().length >= MIN_CONTEXT_CHARS && text.trim().split(/\s+/).length >= 6;
}

// Mots qui, seuls, ne portent aucune information confidentielle.
const FILLER = new Set(
  (
    "bonjour bonsoir salut merci cordialement suite notre votre leur nous vous avec pour dans sans " +
    "chez sur sous entre vers apres avant depuis pendant comme mais donc alors aussi tres plus moins " +
    "cette celui celle ceux elle elles sont etre avoir fait faire peux peut pouvez ecris ecrire " +
    "moi toi lui reunion message mail email objet hello thanks with from about"
  ).split(" ")
);

/**
 * Un morceau restant autour d'un nom déjà masqué ne mérite d'être masqué que
 * s'il porte une information : un chiffre, ou au moins deux mots de contenu.
 * En test réel, Gemma citait des phrases entières et l'on masquait sinon
 * « Bonjour » ou « suite à notre réunion avec ».
 */
function carriesInformation(value: string): boolean {
  if (/\d/.test(value)) return true;
  const words = (value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/\p{L}+/gu) ?? []).filter(
    (word) => word.length >= 4 && !FILLER.has(word)
  );
  return words.length >= 2;
}

/**
 * Retire d'un extrait les zones déjà couvertes par des détections plus fiables
 * et ne garde que les morceaux qui portent encore du sens.
 */
function subtractCovered(excerpt: SensitiveEntity, covered: readonly SensitiveEntity[]): SensitiveEntity[] {
  const overlapping = covered
    .filter((entity) => entity.start < excerpt.end && excerpt.start < entity.end)
    .sort((a, b) => a.start - b.start);
  if (overlapping.length === 0) return [excerpt];

  const pieces: SensitiveEntity[] = [];
  let cursor = excerpt.start;

  for (const entity of [...overlapping, { start: excerpt.end, end: excerpt.end }]) {
    if (entity.start > cursor) {
      const raw = excerpt.value.slice(cursor - excerpt.start, entity.start - excerpt.start);
      // Les morceaux gardent du sens sans la ponctuation laissée par la découpe.
      const leading = /^[\s,.;:!?'’"«»()-]*/u.exec(raw)![0].length;
      const value = raw.slice(leading).replace(/[\s,.;:!?'’"«»()-]+$/u, "");
      if (carriesInformation(value)) {
        const start = cursor + leading;
        pieces.push({ ...excerpt, value, start, end: start + value.length });
      }
    }
    cursor = Math.max(cursor, entity.end);
  }

  return pieces;
}

/** Types que la mémoire de session peut retrouver tels quels dans un nouveau message. */
const REMEMBERED_TYPES: ReadonlySet<string> = new Set([
  "PERSON",
  "ORGANIZATION",
  "LOCATION",
  "ADDRESS",
  "CUSTOM_TERM",
  "ACCOUNT_ID",
  "NATIONAL_ID",
  "REFERENCE",
]);

/**
 * Valeurs déjà masquées plus tôt dans la session : si « Marc » a été masqué
 * dans le premier message, il l'est aussi dans le suivant, même si le NER le
 * rate cette fois.
 */
export function rememberedEntities(text: string, aliases: AliasRegistry | undefined, settings: AnalysisSettings): SensitiveEntity[] {
  if (!aliases) return [];
  const allowed = new Set(settings.categories);
  const found: SensitiveEntity[] = [];
  for (const entry of aliases.values()) {
    if (!REMEMBERED_TYPES.has(entry.type) || !allowed.has(ENTITY_CATEGORY[entry.type])) continue;
    const value = entry.original.trim();
    if (value.length < 3) continue;
    const pattern = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const forms = [new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "giu")];
    // Le nom de famille seul (« Martin » après « Jeanne Martin »), écrit avec sa majuscule.
    const surname = entry.type === "PERSON" && /\s/.test(value) ? value.split(/\s+/).at(-1)! : null;
    if (surname && surname.length >= 3 && /^\p{Lu}/u.test(surname)) {
      forms.push(new RegExp(`(?<![\\p{L}\\p{N}])${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu"));
    }
    for (const match of forms.flatMap((regex) => [...text.matchAll(regex)])) {
      found.push({
        type: entry.type,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
        source: "memory",
        score: 0.9,
        decision: "mask",
        reason: "déjà masqué plus tôt dans la session",
      });
    }
  }
  return found;
}

export type MessageAnalysis = {
  /** Données à masquer, triées et sans chevauchement. */
  entities: SensitiveEntity[];
  /** Candidats examinés puis conservés (utiles à la tâche), proposés décochés dans la revue. */
  kept: SensitiveEntity[];
  task: TaskProfile;
};

/** Retire d'un extrait de contexte les paramètres dont la tâche a besoin (montant d'un calcul…). */
function withoutTaskParameters(excerpt: SensitiveEntity, task: TaskProfile): SensitiveEntity[] {
  const parameters = protectedParameters(task).map((parameter) => ({ ...parameter, type: "CONFIDENTIAL" as const }));
  return subtractCovered(excerpt, parameters);
}

export const LEARNED_REASON = "appris de vos corrections";

/**
 * Passe en « conservé » les détections que l'utilisateur a appris à Cloakly à garder.
 * Elles restent visibles (décochées) dans la revue : rien n'est retiré en silence.
 */
function applyAllowTerms(analysis: MessageAnalysis, settings: AnalysisSettings): MessageAnalysis {
  if (!settings.allowTerms?.length || settings.level === "maximum") return analysis;
  const allowed = new Set(settings.allowTerms.map((term) => fold(term.trim())));
  const learned = (entity: SensitiveEntity) => !SECRET_TYPES.has(entity.type) && allowed.has(fold(entity.value.trim()));
  if (!analysis.entities.some(learned)) return analysis;
  const moved = analysis.entities.filter(learned).map((entity) => ({ ...entity, decision: "keep" as const, reason: LEARNED_REASON }));
  return {
    ...analysis,
    entities: analysis.entities.filter((entity) => !learned(entity)),
    kept: [...analysis.kept, ...moved].sort((a, b) => a.start - b.start),
  };
}

export function analyzeMessage(
  text: string,
  settings: AnalysisSettings,
  findings: AiFindings | null,
  aliases?: AliasRegistry
): MessageAnalysis {
  return applyAllowTerms(analyzeWithoutLearning(text, settings, findings, aliases), settings);
}

function analyzeWithoutLearning(
  text: string,
  settings: AnalysisSettings,
  findings: AiFindings | null,
  aliases?: AliasRegistry
): MessageAnalysis {
  const allowed = new Set(settings.categories);
  const task = analyzeTask(text);
  const classified = classifySensitiveData(text, settings);
  const rules = classified.filter((entity) => entity.decision !== "keep");
  const ner = (findings?.ner ?? []).filter(
    (entity) => allowed.has(ENTITY_CATEGORY[entity.type]) && text.slice(entity.start, entity.end) === entity.value
  );
  const base = mergeEntities([...rules, ...rememberedEntities(text, aliases, settings), ...ner]);
  const keptCandidates = (masked: SensitiveEntity[]) =>
    classified.filter(
      (entity) => entity.decision === "keep" && !masked.some((other) => entity.start < other.end && other.start < entity.end)
    );

  // Le niveau de risque annoncé par le mini-LLM est peu fiable (un rachat non
  // annoncé noté « faible ») : seuls ses extraits vérifiés comptent.
  if (!findings?.verdict || !allowed.has("context") || findings.verdict.risk === "none") {
    return { entities: base, kept: keptCandidates(base), task };
  }

  const excerpts: SensitiveEntity[] = findings.verdict.excerpts.map((excerpt) => ({
    type: "CONFIDENTIAL",
    value: excerpt.value,
    start: excerpt.start,
    end: excerpt.end,
    source: "llm",
  }));

  const entities = mergeEntities([
    ...base,
    ...excerpts
      .flatMap((excerpt) => subtractCovered(excerpt, base))
      .flatMap((excerpt) => withoutTaskParameters(excerpt, task)),
  ]);
  return { entities, kept: keptCandidates(entities), task };
}

/** Données à masquer (contrat historique de combineDetections). */
export function combineDetections(
  text: string,
  settings: AnalysisSettings,
  findings: AiFindings | null
): SensitiveEntity[] {
  return analyzeMessage(text, settings, findings).entities;
}
