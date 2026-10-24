/**
 * Classification par le contexte local : le libellé qui précède un nombre
 * (« commande n° », « tél. », « numéro client »…) décide de sa nature.
 * Un même « 0612345678 » est un téléphone après « appelle-moi au » et une
 * référence de commande après « commande n° ».
 */

export type ContextLabel =
  // Identifiants métier ou techniques, utiles à la tâche.
  | "order"
  | "ticket"
  | "invoice"
  | "tracking"
  | "product"
  | "serial"
  | "error"
  | "version"
  // Identifiants qui désignent une personne ou un compte.
  | "account"
  | "phone"
  | "card"
  | "iban"
  | "nir"
  | "nationalId"
  | "birth";

/** Libellés qui rattachent un numéro à un objet (commande, ticket…) plutôt qu'à une personne. */
export const BUSINESS_LABELS: ReadonlySet<ContextLabel> = new Set([
  "order",
  "ticket",
  "invoice",
  "tracking",
  "product",
  "serial",
  "error",
  "version",
]);

/** Libellés techniques : ce qui suit n'est jamais une donnée personnelle (code d'erreur, version). */
export const TECHNICAL_LABELS: ReadonlySet<ContextLabel> = new Set(["error", "version", "product"]);

// Mots-clés sans accents et en minuscules (cf. fold).
const KEYWORDS: Record<ContextLabel, string[]> = {
  order: ["commande", "cde", "order", "achat", "purchase", "reservation", "booking", "pnr"],
  ticket: ["ticket", "incident", "issue", "bug", "jira", "request", "requete", "demande de support"],
  invoice: ["facture", "invoice", "avoir", "devis", "quote", "bon de livraison", "recu", "receipt", "transaction"],
  tracking: ["suivi", "colis", "tracking", "parcel", "expedition", "envoi", "recommande", "lettre recommandee"],
  product: ["produit", "article", "product", "sku", "ean", "isbn", "asin", "modele", "model", "item", "piece", "part"],
  serial: ["serie", "serial", "s/n", "sn", "imei", "lot"],
  error: ["erreur", "error", "err", "code", "exception", "errno", "status", "statut", "http", "stop code", "bsod"],
  version: ["version", "v", "build", "release", "kb", "update", "patch", "firmware", "noyau", "kernel"],
  account: [
    "client", "customer", "abonne", "subscriber", "adherent", "membre", "member", "compte", "account",
    "identifiant", "user id", "userid", "login", "allocataire", "caf", "mutuelle", "assure", "beneficiaire",
    "patient", "dossier", "dossier medical", "matricule", "employee id", "salarie", "france travail",
    "pole emploi", "contrat", "contract", "police", "policy", "licence", "license key", "badge",
  ],
  phone: [
    "tel", "telephone", "portable", "mobile", "phone", "fixe", "gsm", "whatsapp", "fax", "appeler",
    "appelle", "appelez", "rappeler", "rappelle", "joindre", "joignable", "call", "sms", "numero de tel",
  ],
  card: ["carte", "card", "cb", "visa", "mastercard", "amex", "credit", "debit", "paiement", "payment"],
  iban: ["iban", "rib", "bic", "compte bancaire", "bank account", "virement"],
  nir: ["securite sociale", "secu", "nir", "insee", "carte vitale", "social security", "ssn"],
  nationalId: [
    "passeport", "passport", "carte d'identite", "cni", "identity card", "id card", "permis", "driving licence",
    "driver's license", "drivers license", "numero fiscal", "tax id", "nif", "tin", "titre de sejour",
  ],
  birth: ["ne le", "nee le", "ne(e) le", "date de naissance", "naissance", "dob", "date of birth", "born on", "born", "birthdate"],
};

/** Mots de liaison tolérés entre le libellé et la valeur : « commande n° : 123 », « client is 42 ». */
const CONNECTOR =
  String.raw`(?:\s|n°|no\.?|nº|num(?:ero)?\.?|nr\.?|#|:|=|-|\(|est|is|was|etait|de|du|d'|of|number|id|ref\.?|reference|le|la|mon|ma|my|votre|your|moi|me|au|aux|at|on|sur|a|en|par|via|to|ce|this)*`;

/** Retire accents et casse pour comparer des mots-clés. */
export function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ADJACENT: [ContextLabel, RegExp][] = (Object.keys(KEYWORDS) as ContextLabel[]).map((label) => [
  label,
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${KEYWORDS[label].map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])${CONNECTOR}$`,
    "u"
  ),
]);

const ANYWHERE: [ContextLabel, RegExp][] = (Object.keys(KEYWORDS) as ContextLabel[]).map((label) => [
  label,
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${KEYWORDS[label].map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`,
    "gu"
  ),
]);

// « Tél. 06… » ou « No. 12 » ne terminent pas une phrase : seul un point suivi d'une majuscule compte.
const SENTENCE_END = /[!?\n]|\.\s+(?=\p{Lu})/u;

export type LabelMatch = {
  label: ContextLabel;
  /** Vrai si seuls des mots de liaison séparent le libellé de la valeur. */
  adjacent: boolean;
};

/**
 * Libellé qui qualifie la valeur commençant à `start` : d'abord un libellé
 * directement accolé, sinon le plus proche dans la même proposition (≤ 40 caractères).
 */
export function labelBefore(text: string, start: number, window = 40): LabelMatch | null {
  const raw = text.slice(Math.max(0, start - window), start);
  // On ne remonte pas au-delà d'une fin de phrase ou d'une ligne.
  const clause = fold(raw.split(SENTENCE_END).at(-1) ?? "");

  let best: { label: ContextLabel; length: number } | null = null;
  for (const [label, regex] of ADJACENT) {
    const match = regex.exec(clause);
    // Le libellé le plus long l'emporte : « carte vitale » plutôt que « carte ».
    if (match && (!best || match[0].length > best.length)) best = { label, length: match[0].length };
  }
  if (best) return { label: best.label, adjacent: true };

  let nearest: { label: ContextLabel; end: number } | null = null;
  for (const [label, regex] of ANYWHERE) {
    for (const match of clause.matchAll(regex)) {
      const end = match.index + match[0].length;
      if (!nearest || end > nearest.end) nearest = { label, end };
    }
  }
  return nearest ? { label: nearest.label, adjacent: false } : null;
}

/** Libellé situé juste après la valeur : « 06 12 34 56 78 (portable) ». */
export function labelAfter(text: string, end: number, window = 20): ContextLabel | null {
  const clause = fold(text.slice(end, end + window).split(SENTENCE_END)[0]);
  for (const [label, regex] of ANYWHERE) {
    regex.lastIndex = 0;
    const match = regex.exec(clause);
    if (match && match.index <= 4) return label;
  }
  return null;
}
