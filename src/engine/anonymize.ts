import { ALIAS_PATTERN, type EntityType, type SensitiveEntity } from "./detect";

export type AliasEntry = { alias: string; original: string; type: EntityType };

/**
 * Associe une valeur sensible normalisée (`TYPE:valeur`) à son alias.
 * Réutiliser le même registre garantit une pseudonymisation cohérente :
 * une même valeur reçoit toujours le même alias au sein d'une session.
 */
export type AliasRegistry = Map<string, AliasEntry>;

export type Replacement = {
  type: EntityType;
  original: string;
  alias: string;
};

/** Position d'un remplacement dans le texte d'origine et dans le texte produit. */
export type ReplacementSpan = Replacement & { start: number; end: number; outputStart: number };

export type AnonymizationResult = {
  text: string;
  replacements: Replacement[];
  spans: ReplacementSpan[];
};

/**
 * Libellé des marqueurs envoyés au fournisseur. Il dit le rôle de la donnée
 * (une personne, un téléphone) sans en dire plus : tous les secrets sont des
 * `[SECRET_n]`, tous les identifiants officiels des `[IDENTIFIANT_ADMINISTRATIF_n]`.
 */
export const MARKER_LABELS: Record<EntityType, string> = {
  EMAIL: "EMAIL",
  PHONE: "TELEPHONE",
  IBAN: "IBAN",
  CREDIT_CARD: "CARTE_BANCAIRE",
  SSN_FR: "IDENTIFIANT_ADMINISTRATIF",
  NATIONAL_ID: "IDENTIFIANT_ADMINISTRATIF",
  ACCOUNT_ID: "IDENTIFIANT_DOSSIER",
  ADDRESS: "ADRESSE",
  DATE_OF_BIRTH: "DATE_NAISSANCE",
  IP_ADDRESS: "ADRESSE_IP",
  INTERNAL_URL: "URL_INTERNE",
  REFERENCE: "REFERENCE",
  API_KEY: "SECRET",
  JWT: "SECRET",
  PRIVATE_KEY: "SECRET",
  PASSWORD: "SECRET",
  CUSTOM_TERM: "TERME_CONFIDENTIEL",
  PERSON: "PERSONNE",
  ORGANIZATION: "ORGANISATION",
  LOCATION: "LIEU",
  CONFIDENTIAL: "INFORMATION_SENSIBLE",
};

export function createAliasRegistry(entries: Iterable<[string, AliasEntry]> = []): AliasRegistry {
  return new Map(entries);
}

export function serializeRegistry(registry: AliasRegistry): [string, AliasEntry][] {
  return [...registry.entries()];
}

/** Les entités doivent être triées et sans chevauchement (cf. mergeEntities). */
export function anonymizeText(
  text: string,
  entities: readonly SensitiveEntity[],
  aliases: AliasRegistry = createAliasRegistry()
): AnonymizationResult {
  const ordered = [...entities].sort((a, b) => a.start - b.start);
  // Marqueurs déjà écrits par l'utilisateur : un nouvel alias ne doit jamais les reprendre.
  const reserved = new Set([...text.matchAll(ALIAS_PATTERN)].map((match) => match[0]));
  const persons = ordered.filter((entity) => entity.type === "PERSON");
  const replacements: Replacement[] = [];
  const spans: ReplacementSpan[] = [];
  let output = "";
  let cursor = 0;

  for (const entity of ordered) {
    if (entity.start < cursor) {
      throw new Error("Entités qui se chevauchent : impossible d'anonymiser.");
    }

    const alias = aliasFor(entity, aliases, reserved, persons);
    output += text.slice(cursor, entity.start);
    spans.push({ type: entity.type, original: entity.value, alias, start: entity.start, end: entity.end, outputStart: output.length });
    output += alias;
    cursor = entity.end;
    replacements.push({ type: entity.type, original: entity.value, alias });
  }

  output += text.slice(cursor);

  return { text: output, replacements, spans };
}

/** Clé de regroupement : deux écritures d'une même valeur partagent un alias. */
export function entityKey(entity: Pick<SensitiveEntity, "type" | "value">): string {
  return `${entity.type}:${normalizeValue(entity)}`;
}

function nextAlias(label: string, aliases: AliasRegistry, reserved: ReadonlySet<string>): string {
  let highest = 0;
  const pattern = new RegExp(`^\\[${label}_(\\d+)\\]$`);
  for (const entry of aliases.values()) {
    const match = pattern.exec(entry.alias);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  let index = highest + 1;
  while (reserved.has(`[${label}_${index}]`)) index += 1;
  return `[${label}_${index}]`;
}

/**
 * « Dupont » seul, après « Jeanne Dupont », désigne la même personne : il
 * reçoit le même alias, sauf ambiguïté (« Jeanne Dupont » et « Paul Dupont »).
 */
function coreferentAlias(
  entity: SensitiveEntity,
  aliases: AliasRegistry,
  persons: readonly SensitiveEntity[]
): string | null {
  if (entity.type !== "PERSON" || /\s/.test(entity.value.trim())) return null;
  const token = entity.value.trim().toLowerCase();
  // Noms complets du message, puis ceux déjà vus dans la session (« Martin » au message suivant).
  const inMessage = persons.map((person) => person.value);
  const inSession = [...aliases.values()].filter((entry) => entry.type === "PERSON").map((entry) => entry.original);
  for (const candidates of [inMessage, inSession]) {
    const fullNames = new Set(
      candidates
        .map((value) => value.trim())
        .filter((value) => /\s/.test(value) && value.toLowerCase().split(/\s+/).includes(token))
        .map((value) => value.toLowerCase().replace(/\s+/g, " "))
    );
    if (fullNames.size > 1) return null;
    if (fullNames.size === 1) return aliases.get(`PERSON:${[...fullNames][0]}`)?.alias ?? null;
  }
  return null;
}

function aliasFor(
  entity: SensitiveEntity,
  aliases: AliasRegistry,
  reserved: ReadonlySet<string>,
  persons: readonly SensitiveEntity[]
): string {
  const key = entityKey(entity);
  const existing = aliases.get(key);
  if (existing) return existing.alias;

  // Le nom complet peut apparaître après le nom seul : on l'enregistre d'abord.
  if (entity.type === "PERSON" && !/\s/.test(entity.value.trim())) {
    const full = persons.find(
      (person) => /\s/.test(person.value.trim()) && person.value.toLowerCase().split(/\s+/).includes(entity.value.trim().toLowerCase())
    );
    if (full && !aliases.has(entityKey(full))) aliasFor(full, aliases, reserved, []);
  }

  const alias = coreferentAlias(entity, aliases, persons) ?? nextAlias(MARKER_LABELS[entity.type], aliases, reserved);
  aliases.set(key, { alias, original: entity.value, type: entity.type });
  return alias;
}

function normalizeValue(entity: Pick<SensitiveEntity, "type" | "value">): string {
  switch (entity.type) {
    case "PHONE":
    case "CREDIT_CARD":
    case "IBAN":
    case "SSN_FR":
    case "NATIONAL_ID":
    case "ACCOUNT_ID":
    case "REFERENCE":
      return entity.value.replace(/[\s().-]/g, "").replace(/^(?:\+|00)33/, "0").toUpperCase();
    case "API_KEY":
    case "JWT":
    case "PRIVATE_KEY":
    case "PASSWORD":
      return entity.value;
    default:
      return entity.value.toLowerCase().replace(/\s+/g, " ");
  }
}

/**
 * Remplace les alias d'un texte (par exemple la réponse de l'IA) par les
 * valeurs d'origine. Action explicite de l'utilisateur, jamais automatique.
 * Un alias partagé (« Jeanne Dupont » et « Dupont ») est restauré par la forme la plus complète.
 */
export function restoreText(text: string, aliases: AliasRegistry): { text: string; restored: number } {
  const byAlias = new Map<string, string>();
  for (const entry of aliases.values()) {
    const current = byAlias.get(entry.alias);
    if (current === undefined || entry.original.length > current.length) byAlias.set(entry.alias, entry.original);
  }
  let restored = 0;

  const output = text.replace(ALIAS_PATTERN, (alias) => {
    const original = byAlias.get(alias);
    if (original === undefined) return alias;
    restored += 1;
    return original;
  });

  return { text: output, restored };
}
