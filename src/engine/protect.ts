import type { AnalysisSettings } from "./analysis";
import {
  anonymizeText,
  entityKey,
  type AliasRegistry,
  type Replacement,
  type ReplacementSpan,
} from "./anonymize";
import { ALIAS_PATTERN, detectSecrets, detectSensitiveData, type SensitiveEntity } from "./detect";
import { analyzeTask, protectedParameters, type TaskProfile } from "./task";

export type IssueCode =
  | "secret_present"
  | "unprotected_identifier"
  | "masked_value_present"
  | "corrupted"
  | "marker_inconsistent"
  | "marker_collision"
  | "parameter_lost"
  | "action_lost"
  | "unintelligible";

/**
 * `block` : la confidentialité n'est pas garantie, l'envoi est refusé.
 * `warn` : la tâche risque d'être dégradée, l'utilisateur est prévenu.
 * Les messages ne citent jamais la donnée elle-même.
 */
export type ValidationIssue = { code: IssueCode; severity: "block" | "warn"; message: string };

export type Protection = {
  original: string;
  sanitized: string;
  replacements: Replacement[];
  spans: ReplacementSpan[];
  issues: ValidationIssue[];
  /** Vrai si une seconde passe a dû compléter la sélection (autre occurrence oubliée…). */
  retried: boolean;
  /**
   * Vrai uniquement si la validation indépendante n'a relevé aucun problème
   * bloquant. Ne jamais annoncer une protection sinon.
   */
  verified: boolean;
};

const ISSUE_MESSAGES: Record<IssueCode, string> = {
  secret_present: "un secret d'authentification (clé, mot de passe, jeton) est encore présent",
  unprotected_identifier: "une donnée à protéger n'a pas été remplacée",
  masked_value_present: "une valeur masquée apparaît encore ailleurs dans le message",
  corrupted: "le texte a été modifié en dehors des données remplacées",
  marker_inconsistent: "un même marqueur désigne des données différentes",
  marker_collision: "un marqueur reprend un marqueur déjà présent dans votre texte",
  parameter_lost: "un paramètre utile à la tâche (montant, date, code…) serait masqué",
  action_lost: "la consigne principale du message serait masquée",
  unintelligible: "le message serait presque entièrement masqué et risque de devenir incompréhensible",
};

const BLOCKING: ReadonlySet<IssueCode> = new Set([
  "secret_present",
  "unprotected_identifier",
  "masked_value_present",
  "corrupted",
  "marker_inconsistent",
  "marker_collision",
]);

function issue(code: IssueCode): ValidationIssue {
  return { code, severity: BLOCKING.has(code) ? "block" : "warn", message: ISSUE_MESSAGES[code] };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Vrai si `value` apparaît encore dans `text` comme mot entier (casse ignorée). */
function stillPresent(text: string, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  const pattern = escapeRegExp(trimmed).replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** Le texte produit doit être l'original où seuls les passages remplacés diffèrent. */
function isFaithful(original: string, sanitized: string, spans: readonly ReplacementSpan[]): boolean {
  let inCursor = 0;
  let outCursor = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const unchanged = original.slice(inCursor, span.start);
    if (sanitized.slice(outCursor, outCursor + unchanged.length) !== unchanged) return false;
    outCursor += unchanged.length;
    if (outCursor !== span.outputStart || sanitized.slice(outCursor, outCursor + span.alias.length) !== span.alias) {
      return false;
    }
    if (original.slice(span.start, span.end) !== span.original) return false;
    outCursor += span.alias.length;
    inCursor = span.end;
  }
  return sanitized.slice(outCursor) === original.slice(inCursor);
}

/** Un alias partagé n'est admis qu'entre un nom complet et l'un de ses mots (« Jeanne Dupont » / « Dupont »). */
function markersConsistent(spans: readonly ReplacementSpan[]): boolean {
  const byAlias = new Map<string, ReplacementSpan[]>();
  const byKey = new Map<string, string>();
  for (const span of spans) {
    const key = entityKey({ type: span.type, value: span.original });
    if (byKey.has(key) && byKey.get(key) !== span.alias) return false;
    byKey.set(key, span.alias);
    byAlias.set(span.alias, [...(byAlias.get(span.alias) ?? []), span]);
  }
  for (const group of byAlias.values()) {
    const keys = new Set(group.map((span) => entityKey({ type: span.type, value: span.original })));
    if (keys.size <= 1) continue;
    if (!group.every((span) => span.type === "PERSON")) return false;
    const longest = group.reduce((a, b) => (b.original.length > a.original.length ? b : a)).original.toLowerCase();
    const tokens = longest.split(/\s+/);
    if (!group.every((span) => span.original.toLowerCase() === longest || tokens.includes(span.original.toLowerCase()))) {
      return false;
    }
  }
  return true;
}

export type ValidationInput = {
  original: string;
  sanitized: string;
  spans: readonly ReplacementSpan[];
  settings: AnalysisSettings;
  /** Données que l'utilisateur a choisi de garder (décochées dans la revue). */
  kept?: readonly SensitiveEntity[];
  aliases?: AliasRegistry;
  /** Marqueurs présents dans l'original et inconnus du registre avant la transformation. */
  foreignMarkers?: ReadonlySet<string>;
  task?: TaskProfile;
};

/**
 * Validation indépendante du texte qui sera transmis : elle relance ses
 * propres détections sur le résultat au lieu de faire confiance au moteur
 * de remplacement.
 */
export function validateTransformation(input: ValidationInput): ValidationIssue[] {
  const { original, sanitized, spans, settings } = input;
  const issues = new Set<IssueCode>();
  const keptKeys = new Set((input.kept ?? []).map(entityKey));

  if (!isFaithful(original, sanitized, spans)) issues.add("corrupted");

  // Contrôle inconditionnel : aucun secret, même si l'utilisateur a voulu le garder.
  if (detectSecrets(sanitized).length > 0) issues.add("secret_present");

  if (detectSensitiveData(sanitized, settings).some((entity) => !keptKeys.has(entityKey(entity)))) {
    issues.add("unprotected_identifier");
  }

  // Valeurs masquées dans ce message, ou associées à un marqueur présent dans le texte envoyé.
  const masked = new Set(spans.map((span) => span.original));
  const markers = new Set([...sanitized.matchAll(ALIAS_PATTERN)].map((match) => match[0]));
  for (const entry of input.aliases?.values() ?? []) {
    if (markers.has(entry.alias)) masked.add(entry.original);
  }
  const keptValues = new Set((input.kept ?? []).map((entity) => entity.value.toLowerCase()));
  if ([...masked].some((value) => !keptValues.has(value.toLowerCase()) && stillPresent(sanitized, value))) {
    issues.add("masked_value_present");
  }

  if (!markersConsistent(spans)) issues.add("marker_inconsistent");
  if (spans.some((span) => input.foreignMarkers?.has(span.alias))) issues.add("marker_collision");

  const task = input.task ?? analyzeTask(original);
  const overlaps = (item: { start: number; end: number }, types?: ReadonlySet<string>) =>
    spans.some((span) => item.start < span.end && span.start < item.end && (!types || types.has(span.type)));
  // Seule une détection de contexte (IA) peut avaler un montant ou une date par erreur ;
  // un identifiant masqué (date de naissance, n° client) l'est volontairement.
  if (protectedParameters(task).some((parameter) => overlaps(parameter, CONTEXT_TYPES))) issues.add("parameter_lost");
  if (task.action && overlaps(task.action)) issues.add("action_lost");

  const visible = original.replace(/\s+/g, "").length;
  const hidden = spans.reduce((total, span) => total + span.original.replace(/\s+/g, "").length, 0);
  // Une longue clé masquée ne rend pas le message incompréhensible s'il reste une vraie question autour.
  const remainingWords = sanitized.replace(ALIAS_PATTERN, " ").match(/\p{L}{2,}/gu)?.length ?? 0;
  if (visible >= 30 && ((hidden / visible > 0.8 && remainingWords < 2) || remainingWords === 0)) issues.add("unintelligible");

  return [...issues].map(issue);
}

const CONTEXT_TYPES: ReadonlySet<string> = new Set(["CONFIDENTIAL"]);

export function hasBlockingIssue(issues: readonly ValidationIssue[]): boolean {
  return issues.some((item) => item.severity === "block");
}

/**
 * Ajoute les autres occurrences des valeurs trouvées par l'IA : le modèle peut
 * ne repérer « Marc » qu'une fois alors qu'il apparaît trois fois.
 */
export function expandOccurrences(text: string, entities: readonly SensitiveEntity[]): SensitiveEntity[] {
  const result = [...entities];

  for (const entity of entities) {
    if (!entity.source || entity.source === "rules" || entity.decision === "keep") continue;
    const pattern = escapeRegExp(entity.value).replace(/\s+/g, "\\s+");
    const regex = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "giu");

    for (const match of text.matchAll(regex)) {
      const start = match.index;
      const end = start + match[0].length;
      if (result.some((other) => start < other.end && other.start < end)) continue;
      result.push({ ...entity, value: match[0], start, end });
    }
  }

  return result.sort((a, b) => a.start - b.start);
}

/**
 * Seconde passe sûre : complète la sélection avec ce que la validation a
 * trouvé (autre occurrence, donnée détectée sur le résultat). Elle ne fait
 * qu'ajouter des masquages, jamais restaurer une donnée.
 */
function completeSelection(
  text: string,
  selected: readonly SensitiveEntity[],
  settings: AnalysisSettings,
  kept: readonly SensitiveEntity[]
): SensitiveEntity[] {
  const keptKeys = new Set(kept.map(entityKey));
  const additions = detectSensitiveData(text, settings).filter((entity) => !keptKeys.has(entityKey(entity)));
  const merged = [...selected];
  for (const entity of [...additions, ...expandOccurrences(text, selected.map((item) => ({ ...item, source: item.source === "rules" || !item.source ? "memory" : item.source })))]) {
    if (merged.some((other) => entity.start < other.end && other.start < entity.end)) continue;
    merged.push(entity);
  }
  return merged.sort((a, b) => a.start - b.start);
}

export function protect(
  text: string,
  selected: readonly SensitiveEntity[],
  settings: AnalysisSettings,
  aliases: AliasRegistry,
  kept: readonly SensitiveEntity[] = []
): Protection {
  const known = new Set([...aliases.values()].map((entry) => entry.alias));
  const foreignMarkers = new Set(
    [...text.matchAll(ALIAS_PATTERN)].map((match) => match[0]).filter((marker) => !known.has(marker))
  );
  const task = analyzeTask(text);

  const run = (entities: readonly SensitiveEntity[]) => {
    const result = anonymizeText(text, entities, aliases);
    const issues = validateTransformation({
      original: text,
      sanitized: result.text,
      spans: result.spans,
      settings,
      kept,
      aliases,
      foreignMarkers,
      task,
    });
    return { result, issues };
  };

  let { result, issues } = run(selected);
  let retried = false;
  if (issues.some((item) => item.code === "unprotected_identifier" || item.code === "masked_value_present")) {
    retried = true;
    ({ result, issues } = run(completeSelection(text, selected, settings, kept)));
  }

  return {
    original: text,
    sanitized: result.text,
    replacements: result.replacements,
    spans: result.spans,
    issues,
    retried,
    verified: !hasBlockingIssue(issues),
  };
}

/** Normalise les espaces pour comparer un texte relu depuis un éditeur riche. */
export function normalizeForComparison(text: string): string {
  // \s couvre déjà l'espace insécable ; \p{Cf} couvre les caractères invisibles (U+200B…).
  return text.replace(/[\s\p{Cf}]+/gu, " ").trim();
}

/**
 * Vérifie que le contenu effectivement présent dans l'éditeur correspond au
 * texte pseudonymisé attendu et ne contient ni secret ni donnée masquée.
 */
export function verifyEditorContent(
  actual: string,
  expected: string,
  settings: AnalysisSettings,
  maskedValues: readonly string[] = [],
  kept: readonly SensitiveEntity[] = []
): boolean {
  const keptKeys = new Set(kept.map(entityKey));
  return (
    normalizeForComparison(actual) === normalizeForComparison(expected) &&
    detectSecrets(actual).length === 0 &&
    detectSensitiveData(actual, settings).every((entity) => keptKeys.has(entityKey(entity))) &&
    !maskedValues.some((value) => stillPresent(actual, value))
  );
}
