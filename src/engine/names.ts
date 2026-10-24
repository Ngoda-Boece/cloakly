import { fold } from "./context";
import type { EntityType, SensitiveEntity } from "./detect";

/**
 * Détection sans modèle des noms de personnes, adresses postales et dates de
 * naissance. Un mot en majuscule ne suffit jamais : il faut un indice
 * (civilité, « je m'appelle », lien de parenté, champ « Nom : », formule de
 * politesse) ou un prénom connu suivi d'un nom.
 */

type Candidate = SensitiveEntity & { score: number; reason: string };

// Lettres avec diacritiques combinants (NFD) éventuels.
const UPPER_WORD = String.raw`\p{Lu}[\p{Ll}\p{M}]+(?:[-'’]\p{Lu}?[\p{Ll}\p{M}]+)*`;
const CAPS_WORD = String.raw`\p{Lu}{2,}(?:[-'’]\p{Lu}{2,})*`;
const TOKEN = `(?:${UPPER_WORD}|${CAPS_WORD})`;
const PARTICLE = String.raw`(?:de la|de|du|des|d'|d’|le|la|van|von|der|den|di|da|del|dos|ben|bin|ibn|al|el)`;
/** Un à trois mots, particules comprises : « Jean-Pierre de La Tour ». */
const NAME = `${TOKEN}(?:\\s+(?:${PARTICLE}\\s*)?${TOKEN}){0,2}`;

/** Mots qui prennent une majuscule sans être des noms (début de phrase, jours, produits…). */
const NOT_NAMES = new Set(
  (
    "le la les un une des je tu il elle on nous vous ils elles mon ma mes ton ta tes son sa ses ce cette ces " +
    "the a an i my your our his her its this that it we you they he she me merci bonjour bonsoir salut hello " +
    "cordialement monsieur madame mademoiselle docteur lundi mardi mercredi jeudi vendredi samedi dimanche " +
    "janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre monday tuesday " +
    "wednesday thursday friday saturday sunday january february march april may june july august september " +
    "october november december chatgpt claude gemini gemma mistral copilot siri alexa windows linux python " +
    "excel word chrome google microsoft apple amazon android iphone java javascript typescript sql paris " +
    "france tous tout toutes everyone all team equipe world monde ok oui non yes no service support client " +
    "urgent important objet re fw fwd pj string number boolean object integer int float double list array " +
    "date text varchar null none true false"
  ).split(" ")
);

/**
 * Prénoms courants (français, anglais, espagnols, portugais, arabes…). Les
 * prénoms ambigus (Rose, Grace, Ruby, Pascal, Florence, Max…) en sont exclus :
 * ce sont aussi des mots, des villes ou des langages.
 */
const FIRST_NAMES = new Set(
  (
    "adam adele adrien agathe agnes ahmed aicha alain alban albert alexandre alexis alice alicia aline amandine " +
    "amelie anais andre andrea angelique anne annie antoine arnaud arthur aurelie aurelien axel baptiste " +
    "barbara bastien beatrice benjamin benoit bernard bertrand brigitte bruno camille carole caroline catherine " +
    "cecile celine chantal charles charlotte chloe christian christine christophe claire clara clement clementine " +
    "colette corinne cyril damien daniel david delphine denis didier dominique dylan edouard elisa elise elodie " +
    "emile emilie emma emmanuel enzo eric estelle etienne eva fabien fabrice fanny farid fatima fatou florian " +
    "francis francois francoise frederic gabriel gael gaelle genevieve georges gerard gilles gisele guillaume " +
    "helene henri hugo ines isabelle jacqueline jacques jeanne jean jeremy jerome joel johanna jonathan joseph " +
    "josephine julie julien juliette justine karim karine kevin laetitia lea lea leo leon lina lionel louis " +
    "louise luc lucas lucie lucien ludovic manon marc marcel margaux marguerite marie marine marion martin " +
    "martine mathieu mathilde matthieu maxime melanie michel michele mickael mohamed nadia nadine natacha " +
    "nathalie nicolas nicole noah noemie olivier oceane pascale patrice patricia patrick paul pauline philippe " +
    "pierre quentin rachid raphael regis remi renaud rene robert romain romane sabrina samuel sandrine sarah " +
    "sebastien serge simon simone solene sophie stephane stephanie suzanne sylvain sylvie theo thierry thomas " +
    "timothee tristan valentin valerie vanessa veronique victor vincent virginie xavier yann yannick yasmine " +
    "yves yvonne zoe " +
    "aaron abigail alan albert alex alexander amanda amy andrew angela anna anthony ashley barbara betty brandon " +
    "brian carl carol charles christopher cynthia daniel deborah dennis donald donna dorothy douglas edward " +
    "elizabeth emily eric ethan gary george gregory hannah harry heather helen henry jack jacob james " +
    "jason jennifer jeffrey jeremy jessica john jonathan joshua julie justin karen katherine kathleen kenneth " +
    "kevin kimberly larry laura linda lisa margaret maria mary matthew megan melissa michael michelle " +
    "nancy nicholas nicole oliver olivia patricia patrick paul peter rachel raymond rebecca richard robert " +
    "ronald ryan samantha sandra sarah scott sharon stephanie stephen steven susan thomas timothy tyler " +
    "walter william " +
    "alejandro antonio carlos carmen diego fernando francisco javier jorge jose juan lucia luis manuel miguel " +
    "pablo pedro rafael ricardo sofia joao ana beatriz goncalo tiago " +
    "abdel abdelkader ali amina amine fatiha hamza hassan hicham ibrahim kader khadija leila malika mehdi " +
    "mounir mustapha nabil omar rachida samir sofiane yacine youssef zineb " +
    "giulia giuseppe giovanni luca marco matteo francesca hans klaus jurgen stefan wolfgang ingrid " +
    "olga igor ivan natalia sergei dmitri yuki hiroshi kenji"
  ).split(" ")
);

const KNOWLEDGE_CUES = [
  "vie de", "biographie", "oeuvre", "oeuvres", "roman", "livre", "poeme", "poesie", "theorie", "theoreme",
  "tableau", "film", "discours", "citation", "philosophie", "pensee", "epoque", "regne", "qui est", "qui etait",
  "qui a ete", "who is", "who was", "about", "a propos de", "selon", "d'apres", "ecrit par", "written by",
  "biography", "life of", "works of", "theory of", "quotes", "musee", "statue", "rue", "avenue", "boulevard",
  "lycee", "college", "ecole", "universite", "hopital", "prix", "president", "roi", "reine", "empereur",
];

/** Prénom courant, quelle que soit la casse (« fatou » comme « Fatou »). */
export function isKnownFirstName(word: string): boolean {
  return FIRST_NAMES.has(fold(word).split(/[-'’]/)[0]);
}

/** Mot qui prend une majuscule sans désigner quelqu'un (jour, produit, formule…). */
export function isCommonCapitalized(word: string): boolean {
  return NOT_NAMES.has(fold(word));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** « je m'appelle » → motif insensible à la casse sans le drapeau `i` (qui fausserait \p{Lu}). */
function caseless(words: readonly string[]): string {
  return words
    .map((word) =>
      [...escapeRegExp(word)]
        .map((char) => (char.toLowerCase() !== char.toUpperCase() ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char))
        .join("")
        .replace(/ /g, "\\s+")
        .replace(/'/g, "['’]")
    )
    .join("|");
}

const HONORIFICS = [
  "M\\.", "MM\\.", "Mr\\.?", "Mrs\\.?", "Ms\\.?", "Mme", "Mmes", "Mlle", "Dr\\.?", "Pr\\.?", "Sr\\.", "Sra\\.",
  caseless(["monsieur", "madame", "mademoiselle", "docteur", "doctor", "professeur", "professor", "maître", "maitre"]),
  "Sir", "Miss", "Herr", "Frau", "Señor", "Señora",
].join("|");

const INTRO = caseless([
  "je m'appelle", "je me nomme", "mon nom est", "mon nom c'est", "moi c'est", "mon prénom est", "my name is",
  "mein name ist",
  "i am called", "i'm called", "call me", "ich heiße", "me llamo", "mi nombre es", "je soussigné", "je soussignée",
  "i, the undersigned",
]);

const FIELD = caseless([
  "nom complet", "nom de famille", "prénom", "nom", "full name", "first name", "last name", "surname", "name",
  "patient", "patiente", "candidat", "candidate", "destinataire", "expéditeur", "titulaire", "bénéficiaire",
  "employé", "salarié", "signataire", "élève", "enfant", "assuré", "assurée", "locataire",
]);

const RELATION = caseless([
  "mon", "ma", "mes", "notre", "nos", "son", "sa", "my", "our", "his", "her",
]);
const RELATIVES = caseless([
  "fils", "fille", "mari", "femme", "épouse", "époux", "conjoint", "conjointe", "frère", "sœur", "soeur", "père",
  "mère", "collègue", "patron", "patronne", "manager", "chef", "voisin", "voisine", "ami", "amie", "copain",
  "copine", "compagnon", "compagne", "enfant", "bébé", "cousin", "cousine", "oncle", "tante", "neveu", "nièce",
  "grand-père", "grand-mère", "petit-fils", "petite-fille", "associé", "associée", "client", "cliente", "élève",
  "patient", "patiente", "locataire", "propriétaire", "avocat", "avocate", "médecin", "son", "daughter",
  "husband", "wife", "brother", "sister", "father", "mother", "dad", "mom", "mum", "colleague", "coworker",
  "boss", "neighbor", "neighbour", "friend", "kid", "child", "baby", "partner", "uncle", "aunt", "nephew",
  "niece", "grandson", "granddaughter", "tenant", "landlord", "lawyer", "doctor", "student", "employee",
]);

const GREETINGS = caseless([
  "bonjour", "bonsoir", "salut", "coucou", "cher", "chère", "chers", "hello", "hi", "hey", "dear", "hallo", "hola",
]);
const SIGNOFFS = caseless([
  "bien cordialement", "cordialement", "bien à vous", "bien à toi", "amicalement", "amitiés", "bisous", "bises",
  "à bientôt", "merci", "regards", "best regards", "kind regards", "best", "sincerely", "cheers", "thanks",
  "salutations", "respectueusement", "sincères salutations",
]);

type Cue = { regex: RegExp; score: number; reason: string; /** Exclut les noms d'assistants (« Bonjour Claude »). */ strict?: boolean };

const CUES: Cue[] = [
  { regex: new RegExp(`(?<![\\p{L}])(?:${HONORIFICS})\\s+(${NAME})`, "gu"), score: 0.9, reason: "civilité" },
  { regex: new RegExp(`(?:${INTRO})\\s*,?\\s+(${NAME})`, "gu"), score: 0.92, reason: "présentation" },
  {
    regex: new RegExp(`(?<![\\p{L}])(?:${FIELD})\\s*:\\s*(${NAME})`, "gu"),
    score: 0.9,
    reason: "champ nominatif",
  },
  {
    regex: new RegExp(`(?<![\\p{L}])(?:${RELATION})\\s+(?:${RELATIVES})\\s*,?\\s+(${NAME})`, "gu"),
    score: 0.85,
    reason: "lien avec une personne",
  },
  {
    // Aussi dans un message cité : « Traduis : « Bonjour Maëlle, … » ».
    regex: new RegExp(`(?:^|[\\n.!?:«"“]\\s*)(?:${GREETINGS})\\s+(${NAME})(?=\\s*[,!\\n:]|\\s*$)`, "gu"),
    score: 0.75,
    reason: "salutation",
    strict: true,
  },
  {
    regex: new RegExp(`(?:${SIGNOFFS})\\s*[,.!]?[ \\t]*\\n+[ \\t]*(${NAME})[ \\t]*(?=\\n|$)`, "gu"),
    score: 0.85,
    reason: "signature",
    strict: true,
  },
  {
    // Signature sur la même ligne, en fin de message cité : « … Cordialement, Clémence Hamon ».
    regex: new RegExp(`(?<![\\p{L}])(?:${SIGNOFFS})\\s*,[ \\t]*(${NAME})[ \\t]*(?=[»"”])`, "gu"),
    score: 0.85,
    reason: "signature",
    strict: true,
  },
];

const ASSISTANTS = new Set(["chatgpt", "claude", "gemini", "mistral", "copilot", "le chat", "siri", "alexa", "gpt"]);

/** Retire du nom capturé les mots qui n'en sont pas (« Dupont Lundi » → « Dupont »). */
function trimName(value: string): string {
  const parts = value.split(/\s+/);
  while (parts.length > 0 && NOT_NAMES.has(fold(parts.at(-1)!))) parts.pop();
  while (parts.length > 0 && NOT_NAMES.has(fold(parts[0]))) parts.shift();
  return parts.join(" ");
}

function push(out: Candidate[], text: string, start: number, raw: string, score: number, reason: string) {
  const value = trimName(raw);
  if (value.length < 2) return;
  const offset = raw.indexOf(value);
  const at = start + offset;
  if (text.slice(at, at + value.length) !== value) return;
  out.push({ type: "PERSON", value, start: at, end: at + value.length, score, reason, source: "rules" });
}

function precededByKnowledgeCue(text: string, start: number): boolean {
  const before = fold(text.slice(Math.max(0, start - 30), start));
  return KNOWLEDGE_CUES.some((cue) => before.includes(cue));
}

function isSentenceStart(text: string, start: number): boolean {
  const before = text.slice(0, start).trimEnd();
  return before === "" || /[.!?:\n"«“(\-•*]$/u.test(before);
}

/** Nom en capitales qui précède immédiatement un prénom (cherché à la fin du texte qui le précède). */
const PRECEDING_CAPS = new RegExp(`(?<![\\p{L}\\p{N}])(${CAPS_WORD})[ \\t]+$`, "u");

/** Personnes repérées par des indices, puis par les prénoms connus. */
export function detectPersons(text: string, options: { strictPublicFigures?: boolean } = {}): Candidate[] {
  const found: Candidate[] = [];

  for (const cue of CUES) {
    cue.regex.lastIndex = 0;
    for (const match of text.matchAll(cue.regex)) {
      const raw = match[1];
      const start = match.index + match[0].lastIndexOf(raw);
      if (cue.strict && ASSISTANTS.has(fold(raw.split(/\s+/)[0]))) continue;
      push(found, text, start, raw, cue.score, cue.reason);
    }
  }

  // Prénom connu suivi d'un nom : « Sophie Lambert », « Jean DUPONT ».
  // Le nom est lu en avance (lookahead) : « Appelle Marc » ne doit pas consommer « Marc ».
  const lexicon = new RegExp(
    `(?<![\\p{L}\\p{N}])(${UPPER_WORD})(?![\\p{L}\\p{N}])(?=(\\s+(?:${PARTICLE}\\s*)?(${TOKEN})(?![\\p{L}\\p{N}]))?)`,
    "gu"
  );
  for (const match of text.matchAll(lexicon)) {
    const first = match[1];
    if (!FIRST_NAMES.has(fold(first).split(/[-'’]/)[0])) continue;
    let surname = match[3] && !NOT_NAMES.has(fold(match[3])) ? match[3] : null;
    let start = match.index;
    let full = surname ? first + match[2] : first;
    // Forme administrative « NOM Prénom » : « SCHMITT Rachid ». Au moins 4 lettres,
    // pour ne pas prendre un sigle (« DRH Sophie », « CEO Marc ») pour un nom.
    const before = PRECEDING_CAPS.exec(text.slice(0, start));
    if (!surname && before && before[1].replace(/[-'’]/g, "").length >= 4 && !NOT_NAMES.has(fold(before[1]))) {
      surname = before[1];
      start = before.index;
      full = text.slice(start, match.index + first.length);
    }
    if (found.some((other) => start < other.end && other.start < start + full.length)) continue;

    // « la vie de Victor Hugo » : une personnalité publique, utile telle quelle.
    // Elle est signalée comme conservée, l'utilisateur peut choisir de la masquer.
    const publicFigure = !options.strictPublicFigures && precededByKnowledgeCue(text, start);
    if (surname) {
      const value = full;
      found.push({
        type: "PERSON",
        value,
        start,
        end: start + value.length,
        score: 0.8,
        reason: publicFigure ? "personnalité publique probable" : "prénom et nom",
        source: "rules",
        decision: publicFigure ? "keep" : "mask",
      });
    } else {
      // Prénom seul : indice plus faible (encore plus en début de phrase), masqué mais décochable.
      found.push({
        type: "PERSON",
        value: first,
        start,
        end: start + first.length,
        score: isSentenceStart(text, start) ? 0.55 : 0.6,
        reason: publicFigure ? "personnalité publique probable" : "prénom",
        source: "rules",
        decision: publicFigure ? "keep" : "mask",
      });
    }
  }

  return withOtherOccurrences(text, found);
}

/**
 * Une personne repérée une fois l'est partout : « Mme Dupont … Dupont a
 * répondu », « Jeanne Martin … Jeanne viendra ».
 */
function withOtherOccurrences(text: string, found: Candidate[]): Candidate[] {
  const result = [...found];
  const forms = new Map<string, Candidate>();

  for (const person of found) {
    if (person.decision === "keep") continue;
    forms.set(person.value, person);
    const tokens = person.value.split(/\s+/);
    if (tokens.length > 1) {
      const last = tokens.at(-1)!;
      if (last.length >= 3 && !NOT_NAMES.has(fold(last))) forms.set(last, person);
      if (FIRST_NAMES.has(fold(tokens[0]))) forms.set(tokens[0], person);
      // « SCHMITT Rachid … SCHMITT a validé » : le nom en capitales placé en tête.
      else if (/^\p{Lu}{4,}$/u.test(tokens[0]) && !NOT_NAMES.has(fold(tokens[0]))) forms.set(tokens[0], person);
    }
  }

  for (const [form, person] of forms) {
    const regex = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(form)}(?![\\p{L}\\p{N}])`, "gu");
    for (const match of text.matchAll(regex)) {
      const start = match.index;
      const end = start + form.length;
      if (result.some((other) => start < other.end && other.start < end)) continue;
      result.push({ ...person, value: form, start, end, score: person.score * 0.95, reason: "autre occurrence" });
    }
  }

  return result;
}

const STREET_TYPES = caseless([
  "rue", "avenue", "av.", "boulevard", "bd", "allée", "allee", "impasse", "chemin", "place", "quai", "route",
  "square", "résidence", "lotissement", "hameau", "faubourg", "fbg", "cité", "esplanade", "rond-point", "lieu-dit",
]);

const FR_ADDRESS = new RegExp(
  String.raw`(?<![\p{L}\p{N}])\d{1,4}(?:\s?(?:bis|ter|quater|[A-D]))?,?\s+(?:${STREET_TYPES})\s+` +
    // « rue des Lilas », « chemin du Moulin » : le nom de la voie commence par une majuscule ou un chiffre.
    String.raw`(?=(?:(?:de la|de l['’]|du|des|de|d['’]|la|le|les|l['’])\s*)?[\p{Lu}\d])[^\n,;:!?()]{2,50}?` +
    String.raw`(?:(?=\s*[,;:!?()\n]|\s+(?:à|a|au|et|pour|depuis|jusqu|vers|chez|dans)\s|\.(?:\s|$)|$)` +
    String.raw`(?:,?\s*\d{5}\s+\p{Lu}[\p{L}\p{M}'’-]*(?:[ -]\p{Lu}[\p{L}\p{M}'’-]*){0,3}(?:\s+(?:Cedex|CEDEX)(?:\s+\d{1,2})?)?)?)`,
  "gu"
);

const EN_ADDRESS = new RegExp(
  String.raw`(?<![\p{L}\p{N}])\d{1,5}\s+(?:\p{Lu}[\p{L}'-]+\s+){1,3}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Way|Place|Pl\.?|Terrace|Close|Crescent)` +
    String.raw`(?:,?\s+(?:Apt\.?|Suite|Unit)\s*\w+)?(?:,\s*\p{Lu}[\p{L}' -]+)?(?:,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?|\s+[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})?`,
  "gu"
);

const PERSONAL_PLACE = /(?:j'habite|j’habite|habite|domicile|domicilie|demeurant|mon adresse|notre adresse|chez moi|chez nous|i live|my address|our address|home address|residing)/;
const NAVIGATION = /(?:itineraire|trajet|aller (?:de|a|au|du)|comment aller|route (?:de|vers)|directions?|how (?:do i )?get to|itinerary|distance entre|distance from|temps de trajet|livraison a|deliver to)/;

/** Adresses postales complètes (numéro + voie). La ville seule n'est pas masquée. */
export function detectAddresses(text: string): Candidate[] {
  const found: Candidate[] = [];
  const folded = fold(text);
  const navigation = NAVIGATION.test(folded);

  for (const regex of [FR_ADDRESS, EN_ADDRESS]) {
    for (const match of text.matchAll(regex)) {
      // Généralisation : la voie est masquée, le code postal et la ville (peu identifiants,
      // souvent utiles : « la pharmacie la plus proche ») restent visibles.
      const value = match[0]
        .replace(/,?\s*\d{5}\s+\p{Lu}[\s\S]*$/u, "")
        .replace(/,\s*\p{Lu}[\p{L}' -]+(?:,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)?$/u, "")
        .replace(/[\s,.]+$/u, "");
      if (value.split(/\s+/).length < 3) continue;
      const start = match.index;
      const before = folded.slice(Math.max(0, start - 40), start);
      const personal = PERSONAL_PLACE.test(before);
      // Un itinéraire a besoin de l'adresse : conservée sauf si c'est le domicile annoncé.
      const keep = navigation && !personal;
      found.push({
        type: "ADDRESS",
        value,
        start,
        end: start + value.length,
        score: personal ? 0.95 : 0.85,
        reason: keep ? "adresse utile à l'itinéraire" : personal ? "adresse personnelle" : "adresse postale",
        source: "rules",
        decision: keep ? "keep" : "mask",
      });
    }
  }

  return found;
}

const MONTHS =
  "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|" +
  "january|february|march|april|may|june|july|august|september|october|november|december|" +
  "janv\\.?|févr\\.?|fevr\\.?|avr\\.?|juil\\.?|sept\\.?|oct\\.?|nov\\.?|déc\\.?|dec\\.?|jan\\.?|feb\\.?|mar\\.?|apr\\.?|jun\\.?|jul\\.?|aug\\.?|sep\\.?";

const FULL_DATE = String.raw`(?:\d{1,2}[/.-]\d{1,2}[/.-](?:19|20)?\d{2}|(?:19|20)\d{2}-\d{2}-\d{2}|\d{1,2}(?:er)?\s+(?:${MONTHS})\s+(?:19|20)\d{2}|(?:${MONTHS})\s+\d{1,2},?\s+(?:19|20)\d{2})`;

const BIRTH = new RegExp(
  `(?<![\\p{L}])(?:${caseless(["né le", "née le", "né(e) le", "nés le", "né", "née", "date de naissance", "naissance", "dob", "d.o.b.", "date of birth", "born on", "born", "birthdate", "birthday", "geboren am"])})\\s*:?\\s*(?:le\\s+|on\\s+)?(${FULL_DATE})`,
  "gu"
);

/** Date de naissance complète : un quasi-identifiant fort (avec le nom ou le code postal). */
export function detectBirthDates(text: string): Candidate[] {
  return [...text.matchAll(BIRTH)].map((match) => {
    const value = match[1];
    const start = match.index + match[0].lastIndexOf(value);
    return {
      type: "DATE_OF_BIRTH" as EntityType,
      value,
      start,
      end: start + value.length,
      score: 0.9,
      reason: "date de naissance",
      source: "rules" as const,
    };
  });
}
