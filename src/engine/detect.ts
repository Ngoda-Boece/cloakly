import { BUSINESS_LABELS, labelAfter, labelBefore, TECHNICAL_LABELS, type ContextLabel } from "./context";
import { detectAddresses, detectBirthDates, detectPersons } from "./names";
import { analyzeTask, findParameters } from "./task";

export type CategoryId =
  | "personal"
  | "professional"
  | "secrets"
  | "confidential"
  | "identities"
  | "context";

/**
 * - `balanced` (défaut) : masque les identifiants personnels et les secrets,
 *   conserve ce qui sert la tâche (références de commande, IP privées…).
 * - `maximum` : masque aussi les références métier, les IP privées, les
 *   personnalités publiques et les adresses d'un itinéraire.
 */
export type PrivacyLevel = "balanced" | "maximum";

export type EntityType =
  | "EMAIL"
  | "PHONE"
  | "IBAN"
  | "CREDIT_CARD"
  | "SSN_FR"
  | "NATIONAL_ID"
  | "ACCOUNT_ID"
  | "ADDRESS"
  | "DATE_OF_BIRTH"
  | "IP_ADDRESS"
  | "INTERNAL_URL"
  | "REFERENCE"
  | "API_KEY"
  | "JWT"
  | "PRIVATE_KEY"
  | "PASSWORD"
  | "CUSTOM_TERM"
  // Personnes : règles (civilité, présentation…) ou modèle NER.
  | "PERSON"
  // Détections produites par les modèles IA locaux.
  | "ORGANIZATION"
  | "LOCATION"
  | "CONFIDENTIAL";

/** `memory` : valeur déjà masquée plus tôt dans la session, retrouvée telle quelle. */
export type DetectionSource = "rules" | "ner" | "llm" | "memory";

/** `keep` : candidat examiné puis conservé car utile à la tâche ou peu risqué. */
export type Decision = "mask" | "keep";

export type SensitiveEntity = {
  type: EntityType;
  value: string;
  start: number;
  end: number;
  /** Origine de la détection ; absente = règles déterministes. */
  source?: DetectionSource;
  /** Confiance (0–1) : format validé, contexte, modèle. */
  score?: number;
  /** Absente = à masquer. */
  decision?: Decision;
  /** Motif lisible de la classification (sans la valeur). */
  reason?: string;
};

export type DetectOptions = {
  /** Catégories à analyser. Par défaut : toutes. Les secrets sont toujours analysés. */
  categories?: readonly CategoryId[];
  /** Termes confidentiels définis par l'utilisateur (catégorie "confidential"). */
  customTerms?: readonly string[];
  level?: PrivacyLevel;
};

export const ALL_CATEGORIES: readonly CategoryId[] = [
  "personal",
  "professional",
  "secrets",
  "confidential",
  "identities",
  "context",
];

/** Catégories traitées par les règles déterministes (sans IA). */
export const RULE_CATEGORIES: readonly CategoryId[] = [
  "personal",
  "professional",
  "secrets",
  "confidential",
  "identities",
];

export const ENTITY_CATEGORY: Record<EntityType, CategoryId> = {
  EMAIL: "personal",
  PHONE: "personal",
  IBAN: "personal",
  CREDIT_CARD: "personal",
  SSN_FR: "personal",
  NATIONAL_ID: "personal",
  ACCOUNT_ID: "personal",
  ADDRESS: "personal",
  DATE_OF_BIRTH: "personal",
  IP_ADDRESS: "professional",
  INTERNAL_URL: "professional",
  REFERENCE: "professional",
  API_KEY: "secrets",
  JWT: "secrets",
  PRIVATE_KEY: "secrets",
  PASSWORD: "secrets",
  CUSTOM_TERM: "confidential",
  PERSON: "identities",
  ORGANIZATION: "identities",
  LOCATION: "identities",
  CONFIDENTIAL: "context",
};

export const ENTITY_LABELS: Record<EntityType, string> = {
  EMAIL: "Adresse e-mail",
  PHONE: "Numéro de téléphone",
  IBAN: "IBAN",
  CREDIT_CARD: "Carte bancaire",
  SSN_FR: "Numéro de sécurité sociale",
  NATIONAL_ID: "Identifiant administratif",
  ACCOUNT_ID: "Identifiant de compte ou de dossier",
  ADDRESS: "Adresse postale",
  DATE_OF_BIRTH: "Date de naissance",
  IP_ADDRESS: "Adresse IP",
  INTERNAL_URL: "URL interne",
  REFERENCE: "Référence (commande, ticket…)",
  API_KEY: "Clé d'API / jeton",
  JWT: "Jeton JWT",
  PRIVATE_KEY: "Clé privée",
  PASSWORD: "Mot de passe / secret",
  CUSTOM_TERM: "Terme confidentiel",
  PERSON: "Personne",
  ORGANIZATION: "Organisation",
  LOCATION: "Lieu",
  CONFIDENTIAL: "Information confidentielle",
};

/** Secrets d'authentification : jamais transmis, jamais décochables. */
export const SECRET_TYPES: ReadonlySet<EntityType> = new Set(["API_KEY", "JWT", "PRIVATE_KEY", "PASSWORD"]);

/** Formats validés structurellement : verrouillés en mode strict quand la confiance est forte. */
const STRUCTURED_TYPES: ReadonlySet<EntityType> = new Set([
  "EMAIL",
  "PHONE",
  "IBAN",
  "CREDIT_CARD",
  "SSN_FR",
  "NATIONAL_ID",
  "ADDRESS",
  "IP_ADDRESS",
  "INTERNAL_URL",
  "CUSTOM_TERM",
]);

/** Vrai si l'utilisateur ne peut pas décocher cette détection dans la revue. */
export function isLocked(entity: SensitiveEntity, strictMode: boolean): boolean {
  if (SECRET_TYPES.has(entity.type)) return true;
  return (
    strictMode &&
    (entity.source ?? "rules") === "rules" &&
    (entity.score ?? 1) >= 0.9 &&
    STRUCTURED_TYPES.has(entity.type)
  );
}

// En cas de chevauchement à longueur égale, le type le plus spécifique l'emporte.
const PRIORITY: Record<EntityType, number> = {
  PRIVATE_KEY: 100,
  JWT: 90,
  API_KEY: 85,
  PASSWORD: 80,
  CUSTOM_TERM: 75,
  EMAIL: 70,
  PERSON: 68,
  ORGANIZATION: 67,
  INTERNAL_URL: 65,
  IBAN: 60,
  CREDIT_CARD: 55,
  SSN_FR: 50,
  NATIONAL_ID: 48,
  ADDRESS: 46,
  DATE_OF_BIRTH: 45,
  ACCOUNT_ID: 44,
  IP_ADDRESS: 40,
  LOCATION: 30,
  PHONE: 10,
  REFERENCE: 8,
  // Un extrait de contexte englobe souvent d'autres détections plus précises :
  // il ne l'emporte qu'à longueur égale, la priorité joue donc peu.
  CONFIDENTIAL: 5,
};

type MatchContext = { text: string; start: number; end: number; level: PrivacyLevel };

type Classification = {
  type?: EntityType;
  /** Valeur éventuellement raccourcie (IBAN suivi d'un mot). */
  value?: string;
  score: number;
  decision?: Decision;
  reason: string;
};

type Pattern = {
  type: EntityType;
  regex: RegExp;
  /** Groupe(s) capturant(s) à masquer : le premier présent est retenu (0 = toute la correspondance). */
  group?: number | number[];
  /** Valide et classe une correspondance ; null = ce n'est pas ce type de donnée. */
  classify?: (value: string, context: MatchContext, match: RegExpMatchArray) => Classification | null;
};

export const ALIAS_PATTERN = /\[[A-Z_]+_\d+\]/g;

// ——— Secrets ———————————————————————————————————————————————————————————

/** Valeurs d'exemple ou expressions de code : ce ne sont pas des secrets. */
const PLACEHOLDER =
  /^(?:\*+|•+|x{3,}|\.{3,}|<[^>]*>|\$\{?[\w.]+\}?|\{\{[^}]*\}\}|%[\w]+%|\[[A-Z_]+_\d+\]|(?:process\.env|os\.environ|os\.getenv|env)\b.*|(?:your|votre|ton|my|mon|insert|enter|example|exemple|placeholder|dummy|redacted|masque|xxx)[\w-]*|null|none|nil|undefined|true|false|string|str|number|int|bool|boolean|any|required|optional)$/i;

/** Mots qui suivent « mot de passe : / est » sans en être un. */
const NOT_A_SECRET = new Set(
  (
    "expire expiré expirée invalide invalid incorrect incorrecte oublie oublié perdu lost forgotten wrong faux " +
    "fausse correct valide valid requis required manquant missing vide empty bloque bloqué locked change changé " +
    "modifie modifié reset reinitialise réinitialisé trop too pas not toujours always still encore simple faible " +
    "weak fort strong long court short sensible securise sécurisé secure obligatoire mandatory nouveau nouvelle " +
    "new ancien old actuel current refuse refusé rejected accepte accepté accepted demande demandé asked needed " +
    "necessaire nécessaire different différent identique same the le la les un une a an de du des et and ou or " +
    "dans in sur on pour for avec with que qui what which quoi comment how pourquoi why"
  ).split(" ")
);

const SECRET_KEYWORD =
  String.raw`(?:[\w-]*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?key|encryption[_-]?key)[\w-]*|mot de passe|mots de passe|mdp|code secret|code pin|code d['’]acc[eè]s|pin|passcode)`;

/** Clés de configuration qui contiennent « token » ou « password » sans être des secrets. */
const NOT_SECRET_KEYS =
  /(?:tokens|tokeni[sz]\w*|count|length|len|max|min|type|url|uri|endpoint|name|field|label|policy|hint|reset|expir\w*|ttl|limit|size|path|file|header|prefix|id|rule|regex|pattern|strength|placeholder)$|^(?:max|min|num|n)_/i;

function isSecretLike(value: string): boolean {
  return (
    /\d/.test(value) ||
    /[^\p{L}\p{N}]/u.test(value) ||
    /\p{Lu}/u.test(value.slice(1)) ||
    value.length >= 16
  );
}

function classifySecret(value: string, separator: string, keyword: string): Classification | null {
  if (PLACEHOLDER.test(value) || /^\[[A-Z_]+_\d+\]$/.test(value)) return null;
  if (NOT_SECRET_KEYS.test(keyword.trim())) return null;
  const lowered = value.toLowerCase();
  if (NOT_A_SECRET.has(lowered)) return null;
  // Expression de code (« user.password », « getToken() ») : rien à masquer.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) || /[([]/.test(value)) return null;
  // « code PIN : 1234 » : un PIN est numérique.
  if (/^pin$|code pin/i.test(keyword) && !/^\d{4,8}$/.test(value)) return null;
  // « mon mot de passe est oublié » : après « est / is », il faut une valeur qui ressemble à un secret.
  if (/^\s*(?:is|est|was|était)\s*$/i.test(separator) && !isSecretLike(value)) return null;
  return { score: 0.95, reason: "secret après un libellé explicite" };
}

const SECRET_PATTERNS: Pattern[] = [
  {
    type: "PRIVATE_KEY",
    // Bloc complet, ou tronqué (début seul) : on masque jusqu'à la fin pour ne rien laisser fuir.
    regex:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    classify: () => ({ score: 1, reason: "bloc de clé privée" }),
  },
  {
    type: "JWT",
    regex: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    classify: () => ({ score: 0.99, reason: "jeton JWT" }),
  },
  {
    type: "API_KEY",
    regex: new RegExp(
      [
        String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`,
        String.raw`\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`,
        String.raw`\bgh[pousr]_[A-Za-z0-9]{36,}`,
        String.raw`\bgithub_pat_[A-Za-z0-9_]{22,}`,
        String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
        String.raw`\bAIza[0-9A-Za-z_-]{35}`,
        String.raw`\bya29\.[0-9A-Za-z_-]{20,}`,
        String.raw`\bGOCSPX-[0-9A-Za-z_-]{20,}`,
        String.raw`\bxox[abprse]-[A-Za-z0-9-]{10,}`,
        String.raw`\bxapp-[A-Za-z0-9-]{10,}`,
        String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
        String.raw`\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}`,
        String.raw`\bwhsec_[A-Za-z0-9]{24,}`,
        String.raw`\bhf_[A-Za-z0-9]{30,}`,
        String.raw`\bnpm_[A-Za-z0-9]{36}`,
        String.raw`\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}`,
        String.raw`\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}`,
        String.raw`\bdop_v1_[a-f0-9]{64}`,
        String.raw`\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b`,
      ].join("|"),
      "g"
    ),
    classify: () => ({ score: 0.98, reason: "format de clé d'API connu" }),
  },
  {
    // En-tête HTTP : « Authorization: Bearer xxx ».
    type: "API_KEY",
    regex: /\b(?:Bearer|Basic|Token|Digest)\s+([A-Za-z0-9._~+/=-]{16,})/g,
    group: 1,
    classify: (value) => (PLACEHOLDER.test(value) ? null : { score: 0.95, reason: "jeton d'authentification HTTP" }),
  },
  {
    // Variables d'environnement : « STRIPE_KEY=… », « DB_PASS: … ».
    type: "PASSWORD",
    regex: /\b[A-Z][A-Z0-9_]*_(?:KEY|PASS|SECRET|TOKEN|PASSWORD|PWD|CREDENTIALS?)\s*[:=]\s*["']?([^\s"'`]{6,})/g,
    group: 1,
    classify: (value) => classifySecret(value, "=", "key"),
  },
  {
    // « mot de passe : xxx », « password="a b" », « token est Xy12… », « "api_key": "…" »,
    // avec jusqu'à trois mots de précision : « mot de passe Wi-Fi est … », « code PIN de ma carte est … ».
    type: "PASSWORD",
    regex: new RegExp(
      String.raw`(?<![\p{L}\p{N}_])(${SECRET_KEYWORD})` +
        String.raw`((?:\s+(?!(?:is|est|was|était)(?![\p{L}]))[\p{L}\p{N}_'’-]{1,12}){0,3}?)` +
        String.raw`["'\]]?(\s*(?:[:=]|=>|->|→)\s*|\s+(?:is|est|was|était|:)\s+)` +
        String.raw`(?:"([^"\n]{1,200})"|'([^'\n]{1,200})'|` + "`([^`\\n]{1,200})`" + String.raw`|([^\s"'` + "`" + String.raw`,;)}\]]{4,}))`,
      "giu"
    ),
    group: [4, 5, 6, 7],
    classify: (value, _context, match) => {
      // « token count is 1500 », « password length: 12 » : une propriété du secret, pas le secret.
      const qualifiers = (match[2] ?? "").trim().split(/\s+/).filter(Boolean);
      if (qualifiers.some((word) => NOT_SECRET_KEYS.test(word) || /^(?:policy|requires?|exige|doit|must)$/i.test(word))) return null;
      return classifySecret(value, match[3] ?? "", match[1] ?? "");
    },
  },
  {
    // Libellé introduit par un verbe, sans séparateur : « a pour mot de passe Xy#12 »,
    // « avec le mot de passe … », « with the password … ». Sans « : » ni « est »,
    // la valeur doit ressembler à un secret (« avec le mot de passe oublié » ne compte pas).
    type: "PASSWORD",
    regex: new RegExp(
      String.raw`(?<![\p{L}\p{N}_])(?:a|ont|avait|avec|ayant|utilise|using|uses?|with|has|had)\s+` +
        String.raw`(?:(?:pour|comme|le|la|son|sa|leur|the|its|their|as|a)\s+)?(${SECRET_KEYWORD})\s+` +
        // La ponctuation finale (« …Xy#12. ») ne fait pas partie du secret.
        String.raw`([^\s"'` + "`" + String.raw`,;)}\]]{3,}?[^\s"'` + "`" + String.raw`,;)}\].!?:])(?=[.!?:]*(?:\s|$|[,;)]))`,
      "giu"
    ),
    group: 2,
    classify: (value, _context, match) => (isSecretLike(value) ? classifySecret(value, "", match[1] ?? "") : null),
  },
  {
    // Identifiants dans une URL : scheme://user:motdepasse@hôte
    type: "PASSWORD",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi,
    group: 1,
    classify: (value) => (PLACEHOLDER.test(value) ? null : { score: 0.97, reason: "identifiants dans une URL" }),
  },
];

// ——— Identifiants structurés ——————————————————————————————————————————

/** Préfixes émetteurs (IIN) des grands réseaux de cartes. */
function hasCardIssuerPrefix(digits: string): boolean {
  const two = Number(digits.slice(0, 2));
  const four = Number(digits.slice(0, 4));
  const six = Number(digits.slice(0, 6));
  return (
    digits[0] === "4" ||
    (two >= 51 && two <= 55) ||
    (four >= 2221 && four <= 2720) ||
    two === 34 ||
    two === 37 ||
    digits.startsWith("6011") ||
    two === 65 ||
    (six >= 644000 && six <= 649999) ||
    (four >= 3528 && four <= 3589) ||
    (two >= 36 && two <= 38) ||
    (four >= 3000 && four <= 3059) ||
    two === 62 ||
    two === 50 ||
    (two >= 56 && two <= 69)
  );
}

/** Le libellé accolé, ou le plus proche dans la proposition. */
function contextOf(context: MatchContext) {
  return labelBefore(context.text, context.start) ?? (() => {
    const after = labelAfter(context.text, context.end);
    return after ? { label: after, adjacent: true } : null;
  })();
}

/**
 * Un numéro au format d'identifiant personnel mais précédé d'un libellé
 * métier (« commande n° 0612345678 ») change de nature.
 */
function reclassifyByLabel(label: ContextLabel | undefined, context: MatchContext): Classification | null | undefined {
  if (!label) return undefined;
  if (TECHNICAL_LABELS.has(label)) return null;
  if (BUSINESS_LABELS.has(label)) return referenceClassification(label, context.level);
  if (label === "account") return { type: "ACCOUNT_ID", score: 0.8, reason: "identifiant de compte ou de dossier" };
  return undefined;
}

function referenceClassification(label: ContextLabel, level: PrivacyLevel): Classification {
  return {
    type: "REFERENCE",
    score: 0.8,
    decision: level === "maximum" ? "mask" : "keep",
    reason: `référence (${REFERENCE_NAMES[label] ?? "métier"}) utile à la demande`,
  };
}

const REFERENCE_NAMES: Partial<Record<ContextLabel, string>> = {
  order: "commande",
  ticket: "ticket",
  invoice: "facture",
  tracking: "suivi",
  serial: "numéro de série",
};

const PRIVATE_IP = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

const STRUCTURED_PATTERNS: Pattern[] = [
  {
    type: "EMAIL",
    regex: /(?<![\w.%+:/-])[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}\b/gi,
    classify: () => ({ score: 0.99, reason: "adresse e-mail" }),
  },
  {
    type: "INTERNAL_URL",
    regex:
      /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|(?:[\w-]+\.)*[\w-]+\.(?:local|internal|intranet|corp|lan|home\.arpa))(?::\d+)?(?:[/?#][^\s<>"']*)?/gi,
    // localhost ne révèle rien : utile au débogage, conservé sans le signaler.
    classify: (value) =>
      /^https?:\/\/(?:localhost|127\.0\.0\.1)\b/i.test(value) ? null : { score: 0.9, reason: "nom d'hôte interne" },
  },
  {
    type: "IBAN",
    // Casse indifférente (« fr76 3000 … ») : la clé de contrôle écarte les faux positifs.
    regex: /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?\b/g,
    classify: (value, context) => {
      const valid = validateIban(value);
      if (valid) return { value: valid, score: 0.99, reason: "IBAN (clé de contrôle valide)" };
      // Une faute de frappe n'empêche pas l'IBAN d'identifier un compte.
      return contextOf(context)?.label === "iban" ? { score: 0.8, reason: "IBAN annoncé (clé invalide)" } : null;
    },
  },
  {
    type: "CREDIT_CARD",
    regex: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    classify: (value, context) => {
      const digits = value.replace(/\D/g, "");
      const label = contextOf(context);
      const cardLabel = label?.label === "card";
      const valid = luhn(digits);
      const issuer = hasCardIssuerPrefix(digits);
      if (valid && issuer) {
        // Risque élevé : même après « ticket », un numéro de carte valide reste masqué (décochable).
        if (label?.adjacent && BUSINESS_LABELS.has(label.label)) {
          return { score: 0.6, reason: "format de carte bancaire après un libellé métier" };
        }
        return { score: cardLabel ? 0.99 : 0.92, reason: "carte bancaire (Luhn et émetteur valides)" };
      }
      if (cardLabel && (valid || digits.length === 16 || digits.length === 15)) {
        return { score: 0.8, reason: "numéro de carte annoncé" };
      }
      return null;
    },
  },
  {
    // Numéro de sécurité sociale français (NIR), clé optionnelle.
    type: "SSN_FR",
    regex:
      /(?<![\dA-Z])[12] ?\d{2} ?(?:0[1-9]|1[0-2]|[2-9]\d) ?(?:\d{2}|2[AB]) ?\d{3} ?\d{3}(?: ?\d{2})?(?![\dA-Z])/gi,
    classify: (value, context) => {
      const label = contextOf(context);
      const compact = value.replace(/ /g, "");
      if (compact.length === 15) {
        if (nirKeyIsValid(compact)) return { score: 0.97, reason: "NIR (clé valide)" };
        return label?.label === "nir" ? { score: 0.8, reason: "NIR annoncé (clé invalide)" } : null;
      }
      // Sans clé, 13 chiffres peuvent être n'importe quelle référence : le contexte décide.
      if (label?.label === "nir") return { score: 0.9, reason: "NIR annoncé" };
      const relabeled = reclassifyByLabel(label?.label, context);
      if (relabeled !== undefined) return relabeled;
      return { score: 0.6, reason: "format de NIR sans clé ni libellé" };
    },
  },
  {
    // Numéro de sécurité sociale américain.
    type: "NATIONAL_ID",
    regex: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g,
    classify: (_value, context) => {
      const label = contextOf(context)?.label;
      if (label && (BUSINESS_LABELS.has(label) || label === "phone")) return null;
      return { score: label === "nir" || label === "nationalId" ? 0.97 : 0.85, reason: "numéro de sécurité sociale (US)" };
    },
  },
  {
    // Passeport français : 2 chiffres, 2 lettres, 5 chiffres.
    type: "NATIONAL_ID",
    regex: /(?<![\p{L}\p{N}])\d{2}[A-Z]{2}\d{5}(?![\p{L}\p{N}])/gu,
    classify: (_value, context) => {
      const label = contextOf(context)?.label;
      if (label === "nationalId") return { score: 0.95, reason: "numéro de passeport" };
      const relabeled = reclassifyByLabel(label, context);
      if (relabeled !== undefined) return relabeled;
      return { score: 0.7, reason: "format de passeport" };
    },
  },
  {
    type: "IP_ADDRESS",
    regex: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g,
    classify: (value, context) => {
      const parts = value.split(".").map(Number);
      if (parts.some((part) => part > 255)) return null;
      const label = contextOf(context);
      if (label?.label === "version") return null;
      // Masques, boucle locale, adresse nulle : aucune information.
      if (parts[0] === 255 || parts[0] === 127 || parts[0] === 0) return null;
      if (PRIVATE_IP.test(value)) {
        return {
          score: 0.7,
          decision: context.level === "maximum" ? "mask" : "keep",
          reason: "adresse IP privée (réseau local)",
        };
      }
      return { score: 0.9, reason: "adresse IP publique" };
    },
  },
  {
    // Numéros français : 06 12 34 56 78, 06.12.34.56.78, +33 6 12 34 56 78…
    type: "PHONE",
    regex: /(?<![\w+])(?:(?:\+|00)33[ .-]?(?:\(0\)[ .-]?)?|0)[1-9](?:[ .-]?\d{2}){4}(?!\w)/g,
    classify: (value, context) => classifyPhone(value, context),
  },
  {
    // Numéros internationaux au format E.164 approximatif : +44 20 7946 0958…
    type: "PHONE",
    regex: /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?!\w)/g,
    classify: (value, context) => {
      const digits = value.replace(/\D/g, "").length;
      return digits >= 8 && digits <= 15 ? classifyPhone(value, context) : null;
    },
  },
];

function classifyPhone(value: string, context: MatchContext): Classification | null {
  const label = contextOf(context);
  if (label?.label !== "phone") {
    // Seul un libellé accolé (« commande n° ») ou un numéro compact peut faire douter.
    const compact = !/[ .-]/.test(value) && !value.startsWith("+");
    if (label && (label.adjacent || compact)) {
      const relabeled = reclassifyByLabel(label.label, context);
      if (relabeled !== undefined) return relabeled;
    }
  }
  const formatted = /[ .-]/.test(value) || value.startsWith("+");
  return {
    score: label?.label === "phone" ? 0.98 : formatted ? 0.95 : 0.85,
    reason: "numéro de téléphone",
  };
}

/**
 * Identifiants annoncés par leur libellé (« numéro client 482915 »,
 * « passeport : 18AB12345 », « ticket INC-2024-118 ») : le libellé décide.
 */
const LABELED_TOKEN = /(?<![\p{L}\p{N}])(?=[\p{L}\p{N}/._-]*\d)[\p{L}\p{N}][\p{L}\p{N}/._-]{2,30}[\p{L}\p{N}](?![\p{L}\p{N}])/gu;

function labeledIdentifiers(text: string, level: PrivacyLevel, parameters: { start: number; end: number }[]): SensitiveEntity[] {
  const found: SensitiveEntity[] = [];
  for (const match of text.matchAll(LABELED_TOKEN)) {
    const value = match[0];
    const start = match.index;
    const end = start + value.length;
    // Une date, un montant ou une version n'est pas un identifiant.
    if (parameters.some((parameter) => start < parameter.end && parameter.start < end)) continue;
    if (/^\d{1,3}$/.test(value)) continue;
    const label = labelBefore(text, start);
    if (!label?.adjacent) continue;

    let classification: Classification | null = null;
    if (label.label === "account") classification = { type: "ACCOUNT_ID", score: 0.85, reason: "identifiant de compte ou de dossier" };
    else if (label.label === "nationalId") classification = { type: "NATIONAL_ID", score: 0.9, reason: "identifiant administratif annoncé" };
    else if (label.label === "nir") {
      // Le NIR français a 13 chiffres (15 avec la clé) ; plus court, c'est un autre numéro national (SSN…).
      const french = value.replace(/\D/g, "").length >= 13;
      classification = { type: french ? "SSN_FR" : "NATIONAL_ID", score: 0.9, reason: "numéro de sécurité sociale annoncé" };
    }
    else if (BUSINESS_LABELS.has(label.label) && !TECHNICAL_LABELS.has(label.label)) {
      classification = referenceClassification(label.label, level);
    }
    if (!classification) continue;

    found.push({
      type: classification.type!,
      value,
      start,
      end,
      score: classification.score,
      decision: classification.decision ?? "mask",
      reason: classification.reason,
      source: "rules",
    });
  }
  return found;
}

/**
 * Classe chaque candidat : à masquer ou à conserver. Les candidats conservés
 * sont renvoyés pour transparence (revue, métriques), avec `decision: "keep"`.
 */
export function classifySensitiveData(text: string, options: DetectOptions = {}): SensitiveEntity[] {
  const categories = new Set(options.categories ?? ALL_CATEGORIES);
  // Les secrets d'authentification sont toujours recherchés, quelle que soit la configuration.
  categories.add("secrets");
  const level = options.level ?? "balanced";
  const candidates: SensitiveEntity[] = [];

  for (const pattern of [...SECRET_PATTERNS, ...STRUCTURED_PATTERNS]) {
    collectMatches(text, pattern, level, candidates);
  }

  candidates.push(...labeledIdentifiers(text, level, findParameters(text)));

  if (categories.has("personal")) {
    candidates.push(...detectAddresses(text), ...detectBirthDates(text));
  }

  if (categories.has("identities")) {
    const profile = analyzeTask(text);
    // Contexte sensible (santé, enfants…) : on ne garde pas même une personnalité publique probable.
    const sensitive = profile.sensitiveContexts.some((context) => context !== "finance");
    candidates.push(...detectPersons(text, { strictPublicFigures: level === "maximum" || sensitive }));
  }

  if (categories.has("confidential")) {
    for (const regex of customTermPatterns(options.customTerms ?? [])) {
      collectMatches(text, { type: "CUSTOM_TERM", regex, classify: () => ({ score: 1, reason: "terme confidentiel" }) }, level, candidates);
    }
  }

  const allowed = candidates.filter((entity) => {
    if (!categories.has(ENTITY_CATEGORY[entity.type])) return false;
    entity.decision ??= "mask";
    if (level === "maximum" && entity.decision === "keep" && entity.type !== "REFERENCE" && entity.type !== "IP_ADDRESS") {
      entity.decision = "mask";
    }
    return true;
  });

  // Les alias déjà posés par Cloakly ([EMAIL_1]…) ne sont pas des données sensibles.
  const aliasSpans = [...text.matchAll(ALIAS_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const relevant = allowed.filter(
    (entity) => !aliasSpans.some((span) => entity.start < span.end && span.start < entity.end)
  );

  // Un candidat conservé ne doit jamais empêcher le masquage d'un autre qui le chevauche.
  const masked = mergeEntities(relevant.filter((entity) => entity.decision !== "keep"));
  const kept = mergeEntities(relevant.filter((entity) => entity.decision === "keep")).filter(
    (entity) => !masked.some((other) => entity.start < other.end && other.start < entity.end)
  );
  return [...masked, ...kept].sort((a, b) => a.start - b.start);
}

/** Données à masquer (contrat historique) : les candidats conservés en sont exclus. */
export function detectSensitiveData(text: string, options: DetectOptions = {}): SensitiveEntity[] {
  return classifySensitiveData(text, options).filter((entity) => entity.decision !== "keep");
}

/** Secrets d'authentification seuls, sans tenir compte des réglages : contrôle final avant envoi. */
export function detectSecrets(text: string): SensitiveEntity[] {
  const found: SensitiveEntity[] = [];
  for (const pattern of SECRET_PATTERNS) collectMatches(text, pattern, "balanced", found);
  const aliasSpans = [...text.matchAll(ALIAS_PATTERN)].map((match) => [match.index, match.index + match[0].length]);
  return mergeEntities(found.filter((entity) => !aliasSpans.some(([start, end]) => entity.start < end && start < entity.end)));
}

function collectMatches(text: string, pattern: Pattern, level: PrivacyLevel, out: SensitiveEntity[]) {
  const groups = Array.isArray(pattern.group) ? pattern.group : [pattern.group ?? 0];
  const regex = new RegExp(
    pattern.regex.source,
    pattern.regex.flags.includes("d") ? pattern.regex.flags : pattern.regex.flags + "d"
  );

  for (const match of text.matchAll(regex)) {
    const group = groups.find((index) => match[index] !== undefined);
    if (group === undefined) continue;
    const indices = match.indices?.[group];
    const raw = match[group];
    if (!indices || !raw) continue;

    const context = { text, start: indices[0], end: indices[1], level };
    const classification = pattern.classify ? pattern.classify(raw, context, match) : { score: 0.95, reason: "format reconnu" };
    if (!classification) continue;
    const value = classification.value ?? raw;

    out.push({
      type: classification.type ?? pattern.type,
      value,
      start: indices[0],
      end: indices[0] + value.length,
      source: "rules",
      score: classification.score,
      decision: classification.decision ?? "mask",
      reason: classification.reason,
    });
  }
}

function customTermPatterns(terms: readonly string[]): RegExp[] {
  const unique = new Set(
    terms.map((term) => term.trim()).filter((term) => term.length >= 2)
  );

  return [...unique].map(
    (term) =>
      new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExp(term).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`,
        "giu"
      )
  );
}

const SOURCE_RANK: Record<DetectionSource, number> = { rules: 0, memory: 1, ner: 2, llm: 3 };

/**
 * Fusionne des détections de sources différentes en une liste triée sans
 * chevauchement : les règles déterministes l'emportent sur le NER, lui-même
 * prioritaire sur le LLM ; puis les plus longues et les plus spécifiques.
 */
export function mergeEntities(candidates: readonly SensitiveEntity[]): SensitiveEntity[] {
  const ranked = [...candidates].sort(
    (a, b) =>
      SOURCE_RANK[a.source ?? "rules"] - SOURCE_RANK[b.source ?? "rules"] ||
      b.end - b.start - (a.end - a.start) ||
      PRIORITY[b.type] - PRIORITY[a.type] ||
      (b.score ?? 1) - (a.score ?? 1) ||
      a.start - b.start
  );

  const accepted: SensitiveEntity[] = [];
  for (const entity of ranked) {
    if (accepted.some((other) => entity.start < other.end && other.start < entity.end)) {
      continue;
    }
    accepted.push(entity);
  }

  return accepted.sort((a, b) => a.start - b.start);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

function ibanIsValid(compact: string): boolean {
  if (compact.length < 15 || compact.length > 34) return false;

  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;

  for (const char of rearranged) {
    const code = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of code) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }

  return remainder === 1;
}

/**
 * La regex peut avaler un groupe de trop (« … 189 MERC »), on retire donc
 * les caractères de fin jusqu'à obtenir un IBAN valide.
 */
function validateIban(value: string): string | null {
  let candidate = value;

  while (candidate.replace(/ /g, "").length >= 15) {
    if (ibanIsValid(candidate.replace(/ /g, "").toUpperCase())) return candidate;
    candidate = candidate.slice(0, -1).trimEnd();
  }

  return null;
}

function nirKeyIsValid(compact: string): boolean {
  const upper = compact.toUpperCase();
  const department = upper.slice(5, 7).replace("2A", "19").replace("2B", "18");
  const body = upper.slice(0, 5) + department + upper.slice(7, 13);
  if (!/^\d+$/.test(body)) return false;
  const key = Number(upper.slice(13));
  return 97 - Number(BigInt(body) % 97n) === key;
}
