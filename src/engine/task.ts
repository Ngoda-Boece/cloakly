import { fold } from "./context";

/**
 * Ce que l'utilisateur demande et les paramètres dont la réponse dépend.
 * Sert à deux choses : ne pas laisser l'IA de contexte masquer un montant
 * dans une demande de calcul, et vérifier après transformation que la tâche
 * est intacte.
 */

export type TaskKind =
  | "calculation"
  | "translation"
  | "summary"
  | "rewrite"
  | "writing"
  | "cv"
  | "medical"
  | "finance"
  | "travel"
  | "scheduling"
  | "it_support"
  | "code"
  | "administrative"
  | "complaint";

export type ParameterKind = "amount" | "percentage" | "date" | "time" | "duration" | "quantity" | "error_code" | "version";

export type TaskParameter = { kind: ParameterKind; value: string; start: number; end: number };

/** Contextes où la donnée elle-même est sensible : on dissocie l'identité, on garde le contenu utile. */
export type SensitiveContext = "health" | "finance" | "children" | "intimate" | "legal";

export type TaskProfile = {
  kinds: TaskKind[];
  /** Verbe d'action principal, s'il est repérable (« calcule », « translate »…). */
  action: { value: string; start: number; end: number } | null;
  parameters: TaskParameter[];
  sensitiveContexts: SensitiveContext[];
};

export const TASK_LABELS: Record<TaskKind, string> = {
  calculation: "calcul",
  translation: "traduction",
  summary: "résumé",
  rewrite: "reformulation",
  writing: "rédaction",
  cv: "CV",
  medical: "santé",
  finance: "finances",
  travel: "voyage",
  scheduling: "rendez-vous",
  it_support: "support informatique",
  code: "programmation",
  administrative: "démarche administrative",
  complaint: "réclamation",
};

// Mots-clés repliés (sans accents, minuscules) ; un préfixe suffit (« calcul » couvre « calculer »).
const TASK_KEYWORDS: Record<TaskKind, string[]> = {
  calculation: [
    "calcul", "combien", "total", "somme", "additionne", "moyenne", "pourcentage", "budget", "rembourse",
    "mensualite", "interet", "convertis", "how much", "calculate", "compute", "sum", "average", "split",
  ],
  translation: ["tradui", "traduction", "translate", "translation", "en anglais", "en francais", "in english", "in french", "en espagnol"],
  summary: ["resum", "synthese", "synthetise", "summar", "tl;dr", "points cles", "key points"],
  rewrite: ["reformul", "corrige", "ameliore", "relis", "rephrase", "rewrite", "proofread", "improve", "orthographe"],
  writing: ["redige", "ecris", "ecrire", "lettre", "mail", "e-mail", "courrier", "draft", "write", "message"],
  cv: ["cv", "curriculum", "resume", "lettre de motivation", "cover letter", "competences", "skills", "experience professionnelle", "linkedin", "candidature"],
  medical: [
    "medecin", "docteur", "symptome", "douleur", "fievre", "traitement", "medicament", "ordonnance", "diagnostic",
    "maladie", "allergie", "grossesse", "enceinte", "tension", "diabete", "cancer", "depression", "anxiete",
    "therapie", "hopital", "mg", "posologie", "doctor", "symptom", "pain", "fever", "medication", "treatment",
    "diagnosis", "pregnan", "arret maladie", "sick leave", "sante", "health",
  ],
  finance: [
    "salaire", "revenu", "impot", "credit", "pret", "emprunt", "epargne", "banque", "dette", "loyer",
    "salary", "income", "tax", "loan", "mortgage", "savings", "debt", "rent", "invest", "placement",
  ],
  travel: ["voyage", "vol", "hotel", "itineraire", "sejour", "vacances", "billet", "train", "trip", "flight", "travel", "itinerary", "nuits", "nights"],
  scheduling: ["rendez-vous", "rdv", "reunion", "disponib", "creneau", "agenda", "planning", "meeting", "appointment", "schedule", "available"],
  it_support: [
    "erreur", "error", "bug", "plante", "crash", "ne marche pas", "ne fonctionne pas", "doesn't work", "not working",
    "installer", "install", "mise a jour", "update", "windows", "macos", "linux", "android", "ios", "imprimante",
    "printer", "wifi", "reseau", "network", "driver", "pilote", "code d'erreur", "ecran bleu",
  ],
  code: ["code", "fonction", "function", "script", "python", "javascript", "typescript", "sql", "regex", "api", "debug", "compile", "stack trace", "```"],
  administrative: [
    "prefecture", "caf", "impots", "securite sociale", "cpam", "titre de sejour", "passeport", "carte d'identite",
    "mairie", "dossier", "formulaire", "attestation", "demarche", "france travail", "pole emploi", "urssaf", "form",
  ],
  complaint: ["reclamation", "rembours", "litige", "plainte", "pas recu", "jamais recu", "defectueux", "complaint", "refund", "never received", "damaged", "retard", "sav"],
};

export const SENSITIVE_KEYWORDS: Record<SensitiveContext, string[]> = {
  health: TASK_KEYWORDS.medical,
  finance: ["salaire", "dette", "credit", "decouvert", "surendettement", "revenu", "salary", "debt", "overdraft", "bankrupt"],
  children: ["mon fils", "ma fille", "mes enfants", "mon enfant", "bebe", "eleve", "mineur", "my son", "my daughter", "my child", "my kid", "ecole", "creche"],
  intimate: ["sexuel", "sexual", "orientation", "religion", "religieux", "syndicat", "union member", "divorce", "violence", "intime"],
  legal: ["condamn", "casier judiciaire", "garde a vue", "proces", "plainte contre", "avocat", "criminal record", "lawsuit", "arrest"],
};

const ACTION_VERBS = [
  // français (impératif / infinitif après « peux-tu »)
  "calcule", "calculer", "traduis", "traduire", "resume", "resumer", "reformule", "reformuler", "redige", "rediger",
  "ecris", "ecrire", "corrige", "corriger", "explique", "expliquer", "analyse", "analyser", "compare", "comparer",
  "propose", "proposer", "genere", "generer", "cree", "creer", "ameliore", "ameliorer", "liste", "lister",
  "convertis", "convertir", "verifie", "verifier", "aide", "aider", "trouve", "trouver", "planifie", "planifier",
  "organise", "organiser", "prepare", "preparer", "optimise", "optimiser", "repare", "reparer", "donne", "donner",
  "fais", "faire", "estime", "estimer", "relis", "relire", "complete", "completer",
  // anglais
  "calculate", "compute", "translate", "summarize", "summarise", "rewrite", "rephrase", "write", "draft", "fix",
  "explain", "analyze", "analyse", "compare", "suggest", "generate", "create", "improve", "list", "convert",
  "check", "help", "find", "plan", "organize", "prepare", "optimize", "debug", "give", "make", "estimate",
  "proofread", "review",
];

const ACTION_REGEX = new RegExp(`(?<![\\p{L}])(?:${ACTION_VERBS.join("|")})(?![\\p{L}])`, "u");

const NUMBER = String.raw`\d+(?:[  .,]\d{3})*(?:[.,]\d+)?`;
const MONTHS =
  "janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre|" +
  "january|february|march|april|may|june|july|august|september|october|november|december";
const DAYS = "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday";

const PARAMETER_PATTERNS: [ParameterKind, RegExp][] = [
  ["amount", new RegExp(String.raw`(?:[€$£]\s?${NUMBER}(?:\s?(?:k|M|Md|mds?))?|${NUMBER}\s?(?:k|M|Md)?\s?(?:€|\$|£|EUR|USD|GBP|CHF|euros?|dollars?|livres?|francs?)(?![\p{L}]))`, "gu")],
  ["percentage", new RegExp(String.raw`${NUMBER}\s?(?:%|pour ?cent|percent)`, "gu")],
  ["time", /(?<![\p{L}\p{N}])(?:[01]?\d|2[0-3])(?:h(?:[0-5]\d)?|:[0-5]\d(?::[0-5]\d)?)(?:\s?(?:am|pm))?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:1[0-2]|0?[1-9])\s?(?:am|pm)(?![\p{L}])/giu],
  [
    "date",
    new RegExp(
      String.raw`(?<![\p{N}])(?:\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{4}-\d{2}-\d{2}|\d{1,2}(?:er)?\s+(?:${MONTHS})(?:\s+\d{4})?|(?:${MONTHS})\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|(?:${DAYS})(?:\s+\d{1,2})?)(?![\p{N}])`,
      "giu"
    ),
  ],
  [
    "duration",
    new RegExp(
      String.raw`(?<![\p{L}\p{N}])${NUMBER}\s?(?:jours?|nuits?|semaines?|mois|ans?|années?|heures?|h|minutes?|min|secondes?|s|days?|nights?|weeks?|months?|years?|hours?|hrs?|minutes?|seconds?)(?![\p{L}])`,
      "giu"
    ),
  ],
  [
    "quantity",
    new RegExp(String.raw`(?<![\p{L}\p{N}])${NUMBER}\s?(?:kg|g|mg|µg|ml|cl|l|km|m|cm|mm|m²|m2|go|gb|mo|mb|to|tb|ghz|mhz|w|kw|kwh|°c|°f|personnes?|people|pers\.?)(?![\p{L}])`, "giu"),
  ],
  [
    "error_code",
    /(?<![\p{L}\p{N}])(?:0x[0-9A-Fa-f]{4,8}|ERR_[A-Z_]+|E(?:ACCES|NOENT|PERM|CONNREFUSED|CONNRESET|TIMEDOUT|ADDRINUSE|EXIST|ISDIR|NOTDIR|PIPE|AGAIN|HOSTUNREACH|NOTFOUND)|(?:[Ee]rreur|[Ee]rror|[Cc]ode|ERR|[Ss]tatus|HTTP)\s*(?:n°|#|:)?\s*[A-Z_-]*\d[A-Za-z0-9_.-]*)(?![\p{L}\p{N}])/gu,
  ],
  [
    "version",
    /(?<![\p{L}\p{N}.])(?:v|version\s?)?\d+\.\d+(?:\.\d+){0,3}(?![\p{N}])|(?<![\p{L}])(?:Windows|iOS|Android|macOS|Ubuntu|Debian|Python|Node(?:\.js)?|Java|Chrome|Firefox|Safari|Office|Excel)\s\d+(?:\.\d+)*(?![\p{N}])/gu,
  ],
];

function matchesKeyword(folded: string, keyword: string): boolean {
  // Mots courts : on exige un mot entier (« cv » ne doit pas matcher « cvs »).
  if (keyword.length <= 3 || /[^a-z]/.test(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z])${escaped}(?![a-z])`).test(folded);
  }
  return new RegExp(`(?<![a-z])${keyword}`).test(folded);
}

export function findParameters(text: string): TaskParameter[] {
  const found: TaskParameter[] = [];
  for (const [kind, regex] of PARAMETER_PATTERNS) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const value = match[0].trim();
      if (!value) continue;
      const start = match.index + match[0].indexOf(value);
      found.push({ kind, value, start, end: start + value.length });
    }
  }
  // Pas de chevauchement : le plus long l'emporte (« 1 250 € » plutôt que « 250 »).
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: TaskParameter[] = [];
  for (const parameter of found) {
    if (!kept.some((other) => parameter.start < other.end && other.start < parameter.end)) kept.push(parameter);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function analyzeTask(text: string): TaskProfile {
  const folded = fold(text);
  const kinds = (Object.keys(TASK_KEYWORDS) as TaskKind[]).filter((kind) =>
    TASK_KEYWORDS[kind].some((keyword) => matchesKeyword(folded, keyword))
  );
  const sensitiveContexts = (Object.keys(SENSITIVE_KEYWORDS) as SensitiveContext[]).filter((context) =>
    SENSITIVE_KEYWORDS[context].some((keyword) => matchesKeyword(folded, keyword))
  );

  // Repli caractère par caractère (« é » → « e ») : les positions restent celles du texte d'origine.
  let action: TaskProfile["action"] = null;
  const foldedAligned = text
    .split("")
    .map((char) => fold(char).slice(0, 1) || char)
    .join("");
  const match = ACTION_REGEX.exec(foldedAligned);
  if (match) {
    action = { value: text.slice(match.index, match.index + match[0].length), start: match.index, end: match.index + match[0].length };
  }

  return { kinds, action, parameters: findParameters(text), sensitiveContexts };
}

/**
 * Tâches dont la réponse se calcule à partir des nombres, dates et codes du
 * message. Un simple sujet (« salaire ») ne suffit pas : c'est la demande
 * (calculer, planifier, dépanner) qui rend le paramètre indispensable.
 */
const PARAMETER_DEPENDENT: ReadonlySet<TaskKind> = new Set([
  "calculation",
  "travel",
  "scheduling",
  "it_support",
  "code",
  "medical",
  "complaint",
  "administrative",
]);

/** Reformuler, traduire ou résumer marche aussi avec un paramètre remplacé par un marqueur (restauré ensuite). */
const TRANSFORMATIONAL: ReadonlySet<TaskKind> = new Set(["rewrite", "translation", "summary"]);

/** Paramètres à ne pas laisser masquer par une détection de contexte (IA) pour cette tâche. */
export function protectedParameters(profile: TaskProfile): TaskParameter[] {
  const technical = profile.parameters.filter((parameter) => parameter.kind === "error_code" || parameter.kind === "version");
  if (profile.kinds.some((kind) => TRANSFORMATIONAL.has(kind)) && !profile.kinds.includes("calculation")) return technical;
  if (profile.kinds.some((kind) => PARAMETER_DEPENDENT.has(kind))) return profile.parameters;
  // Pour les autres tâches, les codes d'erreur et versions restent toujours utiles.
  return technical;
}
