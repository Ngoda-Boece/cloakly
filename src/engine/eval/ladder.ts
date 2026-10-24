import type { CorpusCase, RiskGroup } from "./corpus";
import {
  ALNUM,
  amount,
  card,
  chars,
  CITIES,
  createRng,
  date,
  DAYS,
  DAYS_EN,
  digits,
  email,
  FIRST,
  FIRST_EN,
  FIRST_FEMALE,
  FIRST_MALE,
  frenchPhone,
  HISTORICAL,
  hour,
  iban,
  int,
  LAST,
  LAST_EN,
  nir,
  password,
  pick,
  pickDistinct,
  slug,
  STREETS,
  usPhone,
  type Rng,
} from "./generator";

/**
 * Série de 25 questions de difficulté croissante (5 par niveau) pour tester
 * Cloakly en conditions réelles sur un site d'IA. Une nouvelle graine donne de
 * nouvelles valeurs : on ne teste jamais deux fois la même série.
 * Données synthétiques uniquement.
 */

export type LadderCase = CorpusCase & { level: 1 | 2 | 3 | 4 | 5 };
type Draft = Omit<CorpusCase, "id">;

const direct = (value: string) => ({ value, group: "direct" as RiskGroup });
const sensitive = (value: string) => ({ value, group: "sensitive" as RiskGroup });
const secret = (value: string) => ({ value, group: "secret" as RiskGroup });
const business = (value: string) => ({ value, group: "business" as RiskGroup });

const fullName = (rng: Rng) => `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
const COMPANIES = ["Verdalis", "Nordexa", "Brivane", "Kelvora", "Altimea"];

const LEVELS: Record<1 | 2 | 3 | 4 | 5, Record<string, (rng: Rng) => Draft>> = {
  1: {
    email: (rng) => {
      const mail = email(rng, pick(rng, FIRST), pick(rng, LAST));
      const until = date(rng);
      return {
        category: "coordonnées",
        text: `Mon adresse est ${mail}, rédige une réponse automatique d'absence jusqu'au ${until}.`,
        mask: [direct(mail)],
        keep: [until],
        intent: ["rédige une réponse automatique"],
      };
    },
    phone: (rng) => {
      const phone = frenchPhone(rng);
      return {
        category: "coordonnées",
        text: `Rappelle-moi au ${phone} : comment configurer un renvoi d'appel sur Android ?`,
        mask: [direct(phone)],
        keep: ["Android"],
        intent: ["comment configurer un renvoi d'appel"],
      };
    },
    intro: (rng) => {
      const name = fullName(rng);
      const job = pick(rng, ["graphiste", "boulanger", "infirmière", "data analyst"]);
      return {
        category: "identité",
        text: `Je m'appelle ${name}, écris une courte bio pour mon profil de ${job}.`,
        mask: [direct(name)],
        keep: [job],
        intent: ["écris une courte bio"],
      };
    },
    "email-en": (rng) => {
      const mail = email(rng, pick(rng, FIRST_EN), pick(rng, LAST_EN));
      return {
        category: "coordonnées",
        text: `My email is ${mail}, write a polite out-of-office reply for next week.`,
        mask: [direct(mail)],
        keep: ["next week"],
        intent: ["write a polite out-of-office reply"],
      };
    },
    card: (rng) => {
      const value = card(rng);
      return {
        category: "bancaire",
        text: `Ma carte ${value} est restée bloquée dans le distributeur, que dois-je faire ?`,
        mask: [direct(value)],
        keep: [],
        intent: ["que dois-je faire"],
      };
    },
  },
  2: {
    meeting: (rng) => {
      const [first, last] = [pick(rng, FIRST), pick(rng, LAST)];
      const mail = email(rng, first, last);
      const [day1, day2] = pickDistinct(rng, DAYS, 2);
      const [h1, h2] = [hour(rng), hour(rng)];
      return {
        category: "rendez-vous",
        text: `Écris à ${pick(rng, ["M.", "Mme"])} ${last} (${mail}) pour décaler notre rendez-vous de ${day1} ${h1} à ${day2} ${h2}.`,
        mask: [direct(last), direct(mail)],
        keep: [`${day1} ${h1}`, `${day2} ${h2}`],
        intent: ["pour décaler notre rendez-vous"],
      };
    },
    transfer: (rng) => {
      const value = iban(rng);
      const name = fullName(rng);
      const sum = amount(rng, 150, 2500);
      return {
        category: "bancaire",
        text: `Virement de ${sum} vers l'IBAN ${value} au nom de ${name} : rédige l'ordre pour ma banque.`,
        mask: [direct(value), direct(name)],
        keep: [sum],
        intent: ["rédige l'ordre pour ma banque"],
      };
    },
    "sale-ad": (rng) => {
      const street = `${int(rng, 1, 90)} ${pick(rng, STREETS)}`;
      const [code, city] = pick(rng, CITIES);
      const phone = frenchPhone(rng);
      const price = amount(rng, 80, 600);
      return {
        category: "adresse",
        text: `J'habite ${street}, ${code} ${city} et mon portable est ${phone}. Rédige une annonce pour vendre mon vélo à ${price}.`,
        mask: [direct(street), direct(phone)],
        keep: [`${code} ${city}`, price],
        intent: ["Rédige une annonce"],
      };
    },
    "landlord-en": (rng) => {
      const name = `${pick(rng, FIRST_EN)} ${pick(rng, LAST_EN)}`;
      const phone = usPhone(rng);
      const day = pick(rng, DAYS_EN);
      return {
        category: "identité",
        text: `Hi, I'm ${name}, call me at ${phone}. Draft an email asking my landlord to fix the heating before ${day}.`,
        mask: [direct(name), direct(phone)],
        keep: [day],
        intent: ["Draft an email"],
      };
    },
    budget: (rng) => {
      const values = [amount(rng, 1800, 4200), amount(rng, 500, 1300), amount(rng, 150, 450)];
      const advisor = pick(rng, LAST);
      return {
        category: "calcul",
        text: `Calcule mon reste à vivre : salaire ${values[0]}, loyer ${values[1]}, crédit auto ${values[2]}. Mon conseiller bancaire s'appelle M. ${advisor}.`,
        mask: [direct(advisor)],
        keep: values,
        intent: ["Calcule mon reste à vivre"],
      };
    },
  },
  3: {
    "historical-teacher": (rng) => {
      const figure = pick(rng, HISTORICAL);
      const teacher = fullName(rng);
      return {
        category: "pièges",
        text: `Résume la vie de ${figure} pour un exposé, puis écris un mot pour l'envoyer à ma professeure ${teacher}.`,
        mask: [direct(teacher)],
        keep: [figure],
        intent: ["Résume la vie"],
      };
    },
    "order-nir": (rng) => {
      const order = `${int(rng, 1, 9)}${digits(rng, 8)}`;
      const sum = amount(rng, 25, 400);
      const value = nir(rng);
      return {
        category: "pièges",
        text: `Ma commande n° ${order} de ${sum} n'est pas arrivée et le vendeur exige mon numéro de sécurité sociale ${value} : écris une réclamation.`,
        mask: [direct(value)],
        keep: [order, sum],
        intent: ["écris une réclamation"],
      };
    },
    "ip-secret": (rng) => {
      const ip = `192.168.${int(rng, 0, 20)}.${int(rng, 2, 250)}`;
      const key = `sk_live_${chars(rng, ALNUM, 24)}`;
      return {
        category: "pièges",
        text: `Le serveur ${ip} renvoie une erreur 401 avec la clé ${key}, que vérifier en premier ?`,
        mask: [secret(key)],
        keep: [ip, "401"],
        intent: ["que vérifier en premier"],
      };
    },
    "version-password": (rng) => {
      const product = pick(rng, ["Ubuntu 24.04", "Windows 11 23H2", "macOS 14.5"]);
      const code = pick(rng, ["0x80070643", "0xC1900101", "E_FAIL"]);
      const pwd = password(rng);
      return {
        category: "pièges",
        text: `${product} affiche l'erreur ${code} après la mise à jour. Le compte admin a pour mot de passe ${pwd}, que faire ?`,
        mask: [secret(pwd)],
        keep: [product, code],
        intent: ["que faire"],
      };
    },
    "ticket-client": (rng) => {
      const ticket = `INC-${int(rng, 10000, 99999)}`;
      const name = fullName(rng);
      const client = String(int(rng, 100000, 999999));
      const delay = `${int(rng, 3, 15)} jours`;
      return {
        category: "pièges",
        text: `Ticket ${ticket} : le client ${name} (numéro client ${client}) attend depuis ${delay}, rédige une relance au support.`,
        mask: [direct(name), direct(client)],
        keep: [ticket, delay],
        intent: ["rédige une relance"],
      };
    },
  },
  4: {
    "list-first-names": (rng) => {
      const [a, b, c] = pickDistinct(rng, FIRST, 3);
      return {
        category: "indices indirects",
        text: `Organise les gardes de la semaine : ${a} le lundi, ${b} le mardi, ${c} le jeudi.`,
        mask: [direct(a), direct(b), direct(c)],
        keep: ["lundi", "mardi", "jeudi"],
        intent: ["Organise les gardes"],
      };
    },
    "quoted-message": (rng) => {
      const [a, b] = pickDistinct(rng, FIRST, 2);
      const sender = `${b} ${pick(rng, LAST)}`;
      const day = pick(rng, DAYS);
      const time = hour(rng);
      return {
        category: "indices indirects",
        text: `Traduis en anglais : « Salut ${a}, je passe te voir ${day} vers ${time}. Bises, ${sender} »`,
        mask: [direct(a), direct(sender)],
        keep: [day, time],
        intent: ["Traduis en anglais"],
      };
    },
    "relative-health": (rng) => {
      const brother = pick(rng, FIRST_MALE);
      const age = `${int(rng, 8, 40)} ans`;
      const condition = pick(rng, ["diabète de type 1", "épilepsie", "trouble bipolaire"]);
      return {
        category: "indices indirects",
        text: `Mon frère ${brother}, ${age}, vient d'apprendre qu'il a un ${condition}, comment l'aider au quotidien ?`,
        mask: [sensitive(brother)],
        keep: [age, condition],
        intent: ["comment l'aider au quotidien"],
      };
    },
    spanish: (rng) => {
      const [first, last] = [pick(rng, FIRST), pick(rng, LAST)];
      const mail = email(rng, first, last);
      return {
        category: "indices indirects",
        text: `Hola, soy ${first} ${last} y mi correo es ${mail}. ¿Puedes escribir una carta de presentación para una tienda?`,
        mask: [direct(`${first} ${last}`), direct(mail)],
        keep: [],
        intent: ["escribir una carta de presentación"],
      };
    },
    lowercase: (rng) => {
      const name = `${pick(rng, FIRST_FEMALE)} ${pick(rng, LAST)}`.toLowerCase();
      const day = pick(rng, DAYS);
      return {
        category: "indices indirects",
        text: `écris un mot d'excuse pour ${name} qui était absente ${day} à cause d'une gastro`,
        mask: [direct(name)],
        keep: [day],
        intent: ["écris un mot d'excuse"],
      };
    },
  },
  5: {
    "disguised-email": (rng) => {
      const value = `${slug(pick(rng, FIRST))}.${slug(pick(rng, LAST))} [at] ${pick(rng, ["exemple", "societe-test", "mail-test"])} [point] fr`;
      return {
        category: "difficile",
        text: `Écris à ${value} pour lui demander le devis de la cuisine, sois bref.`,
        mask: [direct(value)],
        keep: ["devis de la cuisine"],
        intent: ["lui demander le devis"],
      };
    },
    "odd-formats": (rng) => {
      const parts = [pick(rng, ["06", "07"]), digits(rng, 2), digits(rng, 2), digits(rng, 2), digits(rng, 2)];
      const phone = `${parts[0]}-${parts[1]}.${parts[2]} ${parts[3]} ${parts[4]}`;
      const value = iban(rng).toLowerCase();
      return {
        category: "difficile",
        text: `mon numéro : ${phone}, mon iban : ${value}. prépare un mandat de prélèvement SEPA pour mon club de sport.`,
        mask: [direct(phone), direct(value)],
        keep: ["SEPA"],
        intent: ["prépare un mandat de prélèvement"],
      };
    },
    "code-secret": (rng) => {
      const key = chars(rng, "abcdef0123456789", 32);
      return {
        category: "difficile",
        text: `Pourquoi ce code renvoie 403 ?\n\`\`\`python\nimport requests\nr = requests.get(URL, headers={"X-Api-Key": "${key}"})\nprint(r.status_code)\n\`\`\``,
        mask: [secret(key)],
        keep: ["requests.get", "403"],
        intent: ["Pourquoi ce code renvoie 403"],
      };
    },
    "long-mail": (rng) => {
      const [f1, f2, f3, f4] = pickDistinct(rng, FIRST, 4);
      const [l2, l3, l4] = pickDistinct(rng, LAST, 3);
      const mail = email(rng, f2, l2);
      const when = date(rng);
      const budget = amount(rng, 8000, 90000);
      return {
        category: "difficile",
        text:
          `Résume ce mail en trois points :\nBonjour ${f1},\n` +
          `Suite à notre réunion avec M. ${l2} et ${f3} ${l3}, M. ${l2} enverra le contrat depuis ${mail} avant le ${when}. ` +
          `${f3} validera ensuite le budget de ${budget}.\nCordialement,\n${f4} ${l4}`,
        mask: [direct(f1), direct(l2), direct(`${f3} ${l3}`), direct(f3), direct(mail), direct(`${f4} ${l4}`)],
        keep: [when, budget],
        intent: ["Résume ce mail en trois points"],
      };
    },
    "confidential-deal": (rng) => {
      const company = pick(rng, COMPANIES);
      const lead = `${pick(rng, LAST).toUpperCase()} ${pick(rng, FIRST)}`;
      const when = date(rng);
      return {
        category: "difficile",
        text: `Reformule pour le comité de direction : le rachat de ${company} reste confidentiel jusqu'au ${when}, c'est ${lead} qui pilote le dossier.`,
        mask: [business(company), direct(lead)],
        keep: [when],
        intent: ["Reformule pour le comité de direction"],
      };
    },
  },
};

/** 25 questions, de la plus simple à la plus difficile, reproductibles pour une graine donnée. */
export function generateLadder(seed: number): LadderCase[] {
  const rng = createRng(seed);
  return ([1, 2, 3, 4, 5] as const).flatMap((level) =>
    Object.entries(LEVELS[level]).map(([name, template], index) => ({
      id: `L${level}.${index + 1}-${name}`,
      level,
      ...template(rng),
    }))
  );
}
