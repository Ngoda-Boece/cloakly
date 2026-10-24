import type { CorpusCase, RiskGroup } from "./corpus";

/**
 * Générateur de cas synthétiques pour la boucle d'amélioration : des gabarits
 * de messages × des valeurs inventées. L'annotation (`mask`, `keep`, `intent`)
 * est connue par construction. Une même graine redonne exactement le même jeu ;
 * une nouvelle graine donne des cas que le moteur n'a jamais vus.
 * Données synthétiques uniquement (IBAN, cartes et NIR ont une clé valide mais
 * sont tirés au hasard).
 */

type Rng = () => number;
type Draft = Omit<CorpusCase, "id">;

const direct = (value: string) => ({ value, group: "direct" as RiskGroup });
const sensitive = (value: string) => ({ value, group: "sensitive" as RiskGroup });
const secret = (value: string) => ({ value, group: "secret" as RiskGroup });
const business = (value: string) => ({ value, group: "business" as RiskGroup });

/** Mulberry32 : petit générateur pseudo-aléatoire reproductible. */
function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];
const digits = (rng: Rng, count: number) => Array.from({ length: count }, () => int(rng, 0, 9)).join("");
const pad = (value: number, size = 2) => String(value).padStart(size, "0");

function pickDistinct<T>(rng: Rng, items: readonly T[], count: number): T[] {
  const pool = [...items];
  const chosen: T[] = [];
  while (chosen.length < count && pool.length) chosen.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return chosen;
}

const FIRST_FEMALE = ["Élodie", "Inès", "Margaux", "Solène", "Clémence", "Aurélie", "Nadia", "Léa", "Anaïs", "Fatou", "Maëlle", "Justine"];
const FIRST_MALE = ["Mathieu", "Bastien", "Yannick", "Théo", "Rachid", "Grégoire", "Florian", "Sébastien", "Damien", "Quentin", "Mehdi", "Romain"];
const FIRST = [...FIRST_FEMALE, ...FIRST_MALE];
const LAST = ["Rousseau", "Fournier", "Gauthier", "Perrin", "Morel", "Leclerc", "Barbier", "Arnaud", "Renaud", "Schmitt", "Vidal", "Caron", "Picard", "Lemaire", "Brunet", "Hamon", "Blanchard", "Ferreira", "Nguyen", "Diallo"];
const FIRST_EN = ["Olivia", "Ethan", "Megan", "Ryan", "Hannah", "Tyler", "Grace", "Connor", "Abigail", "Logan"];
const LAST_EN = ["Mitchell", "Turner", "Parker", "Edwards", "Stewart", "Morris", "Reed", "Bailey", "Hughes", "Foster"];
const HISTORICAL = ["Louis Pasteur", "Jules Verne", "Simone Veil", "Albert Einstein", "Jean Moulin", "Coco Chanel", "Isaac Newton", "Ada Lovelace", "Gustave Eiffel", "Olympe de Gouges"];
const CITIES = [
  ["75014", "Paris"],
  ["69003", "Lyon"],
  ["31000", "Toulouse"],
  ["44000", "Nantes"],
  ["33800", "Bordeaux"],
  ["59000", "Lille"],
  ["67000", "Strasbourg"],
] as const;
const STREETS = ["rue des Acacias", "avenue du Moulin", "boulevard de la Gare", "impasse des Tilleuls", "allée des Cerisiers", "rue du Château", "chemin des Prés"];
const DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi"];
const DAYS_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "septembre", "octobre", "novembre", "décembre"];
const DOMAINS = ["exemple.fr", "example.com", "societe-test.fr", "mail-test.org"];
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const chars = (rng: Rng, alphabet: string, count: number) =>
  Array.from({ length: count }, () => alphabet[int(rng, 0, alphabet.length - 1)]).join("");
const slug = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z]+/g, "-");
const email = (rng: Rng, first: string, last: string) => `${slug(first)}.${slug(last)}@${pick(rng, DOMAINS)}`;
const hour = (rng: Rng) => pick(rng, ["9h", "10h30", "11h", "14h", "15h30", "16h45", "17h"]);
const date = (rng: Rng) => `${int(rng, 2, 28)} ${pick(rng, MONTHS)}`;

function amount(rng: Rng, min: number, max: number): string {
  const value = int(rng, min, max);
  const euros = value >= 1000 ? `${Math.floor(value / 1000)} ${pad(value % 1000, 3)}` : String(value);
  return rng() < 0.4 ? `${euros},${pad(int(rng, 1, 99))} €` : `${euros} €`;
}

function frenchPhone(rng: Rng): string {
  const pairs = [pick(rng, ["06", "07"]), ...Array.from({ length: 4 }, () => digits(rng, 2))];
  const style = int(rng, 0, 2);
  if (style === 0) return pairs.join(" ");
  if (style === 1) return pairs.join(".");
  return `+33 ${pairs[0][1]} ${pairs.slice(1).join(" ")}`;
}

const usPhone = (rng: Rng) => `+1 ${pick(rng, ["415", "212", "617"])} 555 01${digits(rng, 2)}`;

function iban(rng: Rng): string {
  const bban = digits(rng, 23);
  // Lettres converties (F = 15, R = 27), clé « 00 » provisoire en fin, puis modulo 97.
  const check = pad(98 - Number(BigInt(`${bban}152700`) % 97n));
  const value = `FR${check}${bban}`;
  return rng() < 0.5 ? value : value.replace(/(.{4})/g, "$1 ").trim();
}

function card(rng: Rng): string {
  const body = rng() < 0.5 ? "4" : `5${int(rng, 1, 5)}`;
  let partial = body + digits(rng, 15 - body.length);
  // Chiffre de contrôle de Luhn.
  let sum = 0;
  for (let index = 0; index < partial.length; index++) {
    let digit = Number(partial[partial.length - 1 - index]);
    if (index % 2 === 0) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  partial += String((10 - (sum % 10)) % 10);
  return partial.replace(/(.{4})/g, "$1 ").trim();
}

function nir(rng: Rng): string {
  const parts = [String(int(rng, 1, 2)), pad(int(rng, 50, 99)), pad(int(rng, 1, 12)), pad(pick(rng, [13, 33, 44, 59, 69, 75, 92])), digits(rng, 3), digits(rng, 3)];
  const key = pad(97 - Number(BigInt(parts.join("")) % 97n));
  return [...parts, key].join(" ");
}

const birthDate = (rng: Rng) => `${pad(int(rng, 1, 28))}/${pad(int(rng, 1, 12))}/${int(rng, 1950, 2004)}`;
const password = (rng: Rng) => `${pick(rng, ["Soleil", "Montagne", "Bretagne", "Kiwi", "Falcon"])}${pick(rng, ["!", "#", "$", "&"])}${int(rng, 10, 99)}${pick(rng, ["x", "Z", "q"])}`;

/** Gabarits : chacun reflète une règle déjà fixée par le corpus de référence. */
const TEMPLATES: Record<string, (rng: Rng) => Draft> = {
  "identity-intro": (rng) => {
    const name = `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
    const job = pick(rng, ["infirmier", "comptable", "développeur", "agent immobilier"]);
    return {
      category: "identité",
      text: `Je m'appelle ${name}, peux-tu rédiger une lettre de motivation pour un poste de ${job} ?`,
      mask: [direct(name)],
      keep: [job],
      intent: ["rédiger une lettre de motivation"],
    };
  },
  "identity-intro-en": (rng) => {
    const name = `${pick(rng, FIRST_EN)} ${pick(rng, LAST_EN)}`;
    const job = pick(rng, ["project manager", "nurse", "sales associate"]);
    return {
      category: "identité",
      text: `Hi, my name is ${name}. Can you help me write a reference letter for a ${job} position?`,
      mask: [direct(name)],
      keep: [job],
      intent: ["write a reference letter"],
    };
  },
  "identity-honorific": (rng) => {
    const last = pick(rng, LAST);
    const [day1, day2] = pickDistinct(rng, DAYS, 2);
    const [h1, h2] = [hour(rng), hour(rng)];
    return {
      category: "identité",
      text: `Écris un mail à ${pick(rng, ["M.", "Mme"])} ${last} pour décaler notre rendez-vous de ${day1} ${h1} à ${day2} ${h2}.`,
      mask: [direct(last)],
      keep: [`${day1} ${h1}`, `${day2} ${h2}`],
      intent: ["Écris un mail", "décaler notre rendez-vous"],
    };
  },
  "contact-fr": (rng) => {
    const [first, last] = [pick(rng, FIRST), pick(rng, LAST)];
    const mail = email(rng, first, last);
    const phone = frenchPhone(rng);
    return {
      category: "coordonnées",
      text: `Voici mes coordonnées : ${mail}, ${phone}. Fais-moi une signature de mail sobre.`,
      mask: [direct(mail), direct(phone)],
      keep: [],
      intent: ["Fais-moi une signature"],
    };
  },
  "contact-us": (rng) => {
    const phone = usPhone(rng);
    const mail = email(rng, pick(rng, FIRST_EN), pick(rng, LAST_EN));
    return {
      category: "coordonnées",
      text: `Text me at ${phone} or email ${mail} once the invoice is ready.`,
      mask: [direct(phone), direct(mail)],
      keep: [],
      intent: ["once the invoice is ready"],
    };
  },
  "address-home": (rng) => {
    const street = `${int(rng, 1, 120)} ${pick(rng, STREETS)}`;
    const [code, city] = pick(rng, CITIES);
    return {
      category: "adresse",
      text: `J'habite ${street}, ${code} ${city}. Où se trouve la mairie la plus proche ?`,
      mask: [direct(street)],
      keep: [`${code} ${city}`],
      intent: ["Où se trouve la mairie"],
    };
  },
  "bank-iban": (rng) => {
    const value = iban(rng);
    const sum = amount(rng, 200, 1500);
    return {
      category: "bancaire",
      text: `Prépare un virement de ${sum} vers l'IBAN ${value} pour le loyer.`,
      mask: [direct(value)],
      keep: [sum],
      intent: ["Prépare un virement"],
    };
  },
  "bank-card": (rng) => {
    const value = card(rng);
    const sum = amount(rng, 10, 400);
    return {
      category: "bancaire",
      text: `Ma carte ${value} a été débitée de ${sum} sans raison, rédige une contestation.`,
      mask: [direct(value)],
      keep: [sum],
      intent: ["rédige une contestation"],
    };
  },
  "admin-nir": (rng) => {
    const value = nir(rng);
    return {
      category: "administratif",
      text: `Mon numéro de sécurité sociale est ${value}, aide-moi à remplir la déclaration pour la CPAM.`,
      mask: [direct(value)],
      keep: ["CPAM"],
      intent: ["aide-moi à remplir la déclaration"],
    };
  },
  "admin-birth": (rng) => {
    const value = birthDate(rng);
    return {
      category: "administratif",
      text: `Je suis né le ${value}, à quel âge pourrai-je partir à la retraite ?`,
      mask: [sensitive(value)],
      keep: [],
      intent: ["à quel âge pourrai-je partir"],
    };
  },
  "secret-env": (rng) => {
    const key = `sk_live_${chars(rng, ALNUM, 24)}`;
    return {
      category: "secrets",
      text: `Mon fichier .env :\nSTRIPE_SECRET_KEY=${key}\nNODE_ENV=staging\nPourquoi j'ai une erreur 401 ?`,
      mask: [secret(key)],
      keep: ["NODE_ENV=staging", "401"],
      intent: ["Pourquoi j'ai une erreur 401"],
    };
  },
  "secret-github": (rng) => {
    const token = `ghp_${chars(rng, ALNUM, 36)}`;
    return {
      category: "secrets",
      text: `git clone échoue avec mon token ${token}, comment le renouveler ?`,
      mask: [secret(token)],
      keep: ["git clone"],
      intent: ["comment le renouveler"],
    };
  },
  "secret-aws": (rng) => {
    const key = `AKIA${chars(rng, UPPER_DIGITS, 16)}`;
    return {
      category: "secrets",
      text: `Ma clé d'accès ${key} est-elle encore valide ? Le CLI renvoie AccessDenied.`,
      mask: [secret(key)],
      keep: ["AccessDenied"],
      intent: ["est-elle encore valide"],
    };
  },
  "secret-password": (rng) => {
    const value = password(rng);
    return {
      category: "secrets",
      text: `Mon mot de passe de messagerie est ${value}, est-il assez solide ?`,
      mask: [secret(value)],
      keep: [],
      intent: ["est-il assez solide"],
    };
  },
  "secret-fp-policy": (rng) => {
    const length = `${int(rng, 8, 16)} caractères`;
    const product = pick(rng, ["Keycloak", "Okta", "Google Workspace", "Active Directory"]);
    return {
      category: "secrets (faux positifs)",
      text: `Comment imposer un mot de passe de ${length} minimum dans ${product} ?`,
      mask: [],
      keep: [length, product],
      intent: ["Comment imposer un mot de passe"],
    };
  },
  "calc-budget": (rng) => {
    const values = [amount(rng, 500, 1200), amount(rng, 40, 120), amount(rng, 20, 60), amount(rng, 1800, 4000)];
    return {
      category: "calcul",
      text: `Calcule mes dépenses : loyer ${values[0]}, électricité ${values[1]}, internet ${values[2]}, sur un revenu de ${values[3]}.`,
      mask: [],
      keep: values,
      intent: ["Calcule mes dépenses"],
    };
  },
  "calc-salary-name": (rng) => {
    const name = `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
    const salary = amount(rng, 1800, 5000);
    return {
      category: "calcul",
      text: `Je m'appelle ${name} et je gagne ${salary} brut par mois, combien cela fait-il en net ?`,
      mask: [direct(name)],
      keep: [salary],
      intent: ["combien cela fait-il en net"],
    };
  },
  "medical-child": (rng) => {
    const child = pick(rng, FIRST_FEMALE);
    const age = `${int(rng, 2, 12)} ans`;
    const fever = `${int(rng, 38, 39)},${int(rng, 1, 9)} °C`;
    return {
      category: "santé",
      text: `Ma fille ${child}, ${age}, a ${fever} de fièvre depuis hier, faut-il consulter ?`,
      mask: [sensitive(child)],
      keep: [age, fever],
      intent: ["faut-il consulter"],
    };
  },
  "medical-colleague": (rng) => {
    const colleague = pick(rng, FIRST_FEMALE);
    const condition = pick(rng, ["burn-out", "dépression", "sclérose en plaques", "endométriose"]);
    return {
      category: "santé",
      text: `Ma collègue ${colleague} m'a confié qu'elle souffre de ${condition}, comment l'aider au travail ?`,
      mask: [sensitive(colleague)],
      keep: [condition],
      intent: ["comment l'aider au travail"],
    };
  },
  "it-private-ip": (rng) => {
    const ip = rng() < 0.5 ? `192.168.${int(rng, 0, 10)}.${int(rng, 2, 250)}` : `10.0.${int(rng, 0, 20)}.${int(rng, 2, 250)}`;
    return {
      category: "support informatique",
      text: `La machine ${ip} ne répond plus depuis la mise à jour, que vérifier ?`,
      mask: [],
      keep: [ip],
      intent: ["que vérifier"],
    };
  },
  "it-public-ip": (rng) => {
    const ip = `198.51.100.${int(rng, 2, 250)}`;
    return {
      category: "support informatique",
      text: `Notre serveur de production ${ip} renvoie une erreur 503, comment diagnostiquer ?`,
      mask: [business(ip)],
      keep: ["erreur 503"],
      intent: ["comment diagnostiquer"],
    };
  },
  "it-version": (rng) => {
    const product = pick(rng, ["Ubuntu 22.04", "Android 14", "iOS 17.5", "Windows 10 22H2"]);
    const code = pick(rng, ["0x8007000E", "0xC000021A", "E_ACCESSDENIED", "ERR_CONNECTION_RESET"]);
    return {
      category: "support informatique",
      text: `${product} plante au démarrage avec le code ${code}, une idée ?`,
      mask: [],
      keep: [product, code],
      intent: ["plante au démarrage"],
    };
  },
  "complaint-ticket": (rng) => {
    const ticket = `INC-${int(rng, 10000, 99999)}`;
    const delay = `${int(rng, 3, 20)} jours`;
    return {
      category: "réclamation",
      text: `Relance le support : ticket ${ticket} ouvert il y a ${delay} sans réponse.`,
      mask: [],
      keep: [ticket, delay],
      intent: ["Relance le support"],
    };
  },
  "complaint-order": (rng) => {
    const order = `${int(rng, 1, 9)}${digits(rng, 8)}`;
    const sum = amount(rng, 20, 300);
    return {
      category: "réclamation",
      text: `Ma commande n° ${order} de ${sum} n'est jamais arrivée, écris une réclamation.`,
      mask: [],
      keep: [order, sum],
      intent: ["écris une réclamation"],
    };
  },
  "complaint-client": (rng) => {
    const client = String(int(rng, 100000, 999999));
    return {
      category: "réclamation",
      text: `Mon numéro client ${client} est bloqué, écris un message poli au service client.`,
      mask: [direct(client)],
      keep: [],
      intent: ["écris un message poli"],
    };
  },
  "translate-fr-en": (rng) => {
    const first = pick(rng, FIRST);
    const day = pick(rng, DAYS);
    const time = hour(rng);
    return {
      category: "traduction",
      text: `Traduis en anglais : « Bonjour ${first}, je vous attends ${day} à ${time} devant la gare. »`,
      mask: [direct(first)],
      keep: [day, time],
      intent: ["Traduis en anglais"],
    };
  },
  "summary-mail": (rng) => {
    const [first1, first2] = pickDistinct(rng, FIRST, 2);
    const sender = `${first2} ${pick(rng, LAST)}`;
    const quantity = `${int(rng, 10, 500)} cartons`;
    const when = date(rng);
    return {
      category: "résumé",
      text: `Résume ce mail : « Bonjour ${first1}, je vous confirme la livraison de ${quantity} le ${when}. Cordialement, ${sender} »`,
      mask: [direct(first1), direct(sender)],
      keep: [quantity, when],
      intent: ["Résume ce mail"],
    };
  },
  "signature-en": (rng) => {
    const name = `${pick(rng, FIRST_EN)} ${pick(rng, LAST_EN)}`;
    const day = pick(rng, DAYS_EN);
    return {
      category: "identité",
      text: `Fix the grammar:\nhi all, the meeting is moved to ${day}.\nBest,\n${name}`,
      mask: [direct(name)],
      keep: [day],
      intent: ["Fix the grammar"],
    };
  },
  "multi-planning": (rng) => {
    const [first1, first2] = pickDistinct(rng, FIRST, 2);
    return {
      category: "plusieurs personnes",
      text: `Fais un planning de ménage : ${first1} le lundi, ${first2} le mercredi, ${first1} le samedi.`,
      mask: [direct(first1), direct(first2)],
      keep: ["lundi", "mercredi", "samedi"],
      intent: ["Fais un planning de ménage"],
    };
  },
  "clean-historical": (rng) => {
    const figure = pick(rng, HISTORICAL);
    const question = pick(rng, [
      [`Résume la vie de ${figure} en cinq lignes.`, "Résume la vie"],
      [`Cite trois réalisations importantes de ${figure}.`, "Cite trois réalisations"],
      [`Pourquoi ${figure} est-il resté célèbre ?`, "est-il resté célèbre"],
    ]);
    return { category: "sans donnée personnelle", text: question[0], mask: [], keep: [figure], intent: [question[1]] };
  },
  "clean-travel": (rng) => {
    const [from, to] = pickDistinct(rng, CITIES.map(([, city]) => city), 2);
    const people = `${int(rng, 2, 5)} adultes`;
    const when = date(rng);
    const budget = amount(rng, 200, 900);
    return {
      category: "voyage",
      text: `Trouve un train ${from}–${to} pour ${people} le ${when}, budget ${budget}.`,
      mask: [],
      keep: [`${from}–${to}`, people, when, budget],
      intent: ["Trouve un train"],
    };
  },
  "clean-recipe": (rng) => {
    const people = `${int(rng, 2, 8)} personnes`;
    const dish = pick(rng, ["gratin dauphinois", "quiche lorraine", "ratatouille", "tarte aux pommes"]);
    return {
      category: "sans donnée personnelle",
      text: `Donne-moi une recette de ${dish} pour ${people}.`,
      mask: [],
      keep: [dish, people],
      intent: ["Donne-moi une recette"],
    };
  },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

/**
 * Produit `count` cas reproductibles pour une graine donnée. Chaque gabarit est
 * utilisé à tour de rôle, avec des valeurs différentes à chaque passage.
 */
export function generateCases(seed: number, count = TEMPLATE_NAMES.length * 3): CorpusCase[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, (_, index) => {
    const name = TEMPLATE_NAMES[index % TEMPLATE_NAMES.length];
    return { id: `g${seed}-${index}-${name}`, ...TEMPLATES[name](rng) };
  });
}
