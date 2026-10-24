import { describe, expect, it } from "vitest";
import { analyzeMessage, type AiFindings, type AnalysisSettings } from "./analysis";
import { anonymizeText, createAliasRegistry, restoreText, type AliasRegistry } from "./anonymize";
import {
  ALL_CATEGORIES,
  classifySensitiveData,
  detectSecrets,
  detectSensitiveData,
  isLocked,
  type PrivacyLevel,
  type SensitiveEntity,
} from "./detect";
import { protect, validateTransformation } from "./protect";
import { analyzeTask } from "./task";

// Données synthétiques uniquement (numéros de test publics, noms inventés).

const settings = (level: PrivacyLevel = "balanced"): AnalysisSettings => ({
  categories: ALL_CATEGORIES,
  customTerms: [],
  level,
});

/** Chaîne complète sans IA : analyse, revue acceptée telle quelle, pseudonymisation, validation. */
function run(text: string, options: { level?: PrivacyLevel; aliases?: AliasRegistry; findings?: AiFindings } = {}) {
  const config = settings(options.level);
  const aliases = options.aliases ?? createAliasRegistry();
  const analysis = analyzeMessage(text, config, options.findings ?? null, aliases);
  const protection = protect(text, analysis.entities, config, aliases, analysis.kept);
  return { analysis, protection, sanitized: protection.sanitized, aliases };
}

const masked = (text: string, level?: PrivacyLevel) =>
  detectSensitiveData(text, settings(level)).map((entity) => `${entity.type}:${entity.value}`);

const kept = (text: string, level?: PrivacyLevel) =>
  classifySensitiveData(text, settings(level))
    .filter((entity) => entity.decision === "keep")
    .map((entity) => `${entity.type}:${entity.value}`);

/** Marqueur bien formé, qui ne contient rien de la valeur d'origine. */
function expectCleanMarkers(sanitized: string, originals: string[]) {
  for (const marker of sanitized.match(/\[[A-Z_]+_\d+\]/g) ?? []) {
    expect(marker).toMatch(/^\[[A-Z]+(?:_[A-Z]+)*_\d+\]$/);
    for (const original of originals) expect(marker.toLowerCase()).not.toContain(original.toLowerCase());
  }
}

describe("noms de personnes (sans modèle)", () => {
  it("repère un nom annoncé, garde la civilité et l'accord", () => {
    const { sanitized, protection } = run("Écris un mail à Mme Durand pour reporter la réunion de mardi 14h.");
    expect(sanitized).toBe("Écris un mail à Mme [PERSONNE_1] pour reporter la réunion de mardi 14h.");
    expect(protection.verified).toBe(true);
  });

  it.each([
    ["Je m'appelle Jeanne Martin, rédige ma lettre.", "Jeanne Martin"],
    ["My name is Rachel Green and I need a CV.", "Rachel Green"],
    ["Mon fils Lucas a de la fièvre.", "Lucas"],
    ["Nom : Karim Benali\nPoste : développeur", "Karim Benali"],
    ["Peux-tu corriger ?\nBonjour Sophie,\nmerci.\nCordialement,\nLaurent Chevalier", "Laurent Chevalier"],
  ])("détecte la personne dans « %s »", (text, name) => {
    expect(masked(text)).toContain(`PERSON:${name}`);
    expect(run(text).sanitized).not.toContain(name);
  });

  it("ne prend pas pour des personnes les mots capitalisés ordinaires", () => {
    expect(masked("Hello World, bonjour Claude ! interface User { name: String }")).toEqual([]);
    expect(masked("Explique-moi la différence entre TCP et UDP.")).toEqual([]);
  });

  it("garde une personnalité publique dans une question de culture, la masque en niveau maximal", () => {
    expect(masked("Résume la vie de Victor Hugo.")).toEqual([]);
    expect(kept("Résume la vie de Victor Hugo.")).toEqual(["PERSON:Victor Hugo"]);
    expect(masked("Résume la vie de Victor Hugo.", "maximum")).toEqual(["PERSON:Victor Hugo"]);
  });

  it("donne le même marqueur à toutes les occurrences, y compris au nom seul", () => {
    const { sanitized } = run("Jeanne Dupont a écrit. Réponds à Jeanne Dupont ; Dupont attend.");
    expect(sanitized).toBe("[PERSONNE_1] a écrit. Réponds à [PERSONNE_1] ; [PERSONNE_1] attend.");
  });

  it("distingue deux personnes, même avec le même prénom", () => {
    const { sanitized } = run("Compare Pierre Dubois et Pierre Lambert pour le poste.");
    expect(sanitized).toBe("Compare [PERSONNE_1] et [PERSONNE_2] pour le poste.");
  });

  it("ne rattache pas un nom ambigu à l'une des deux personnes", () => {
    const text = "Paul Martin et Anne Martin sont venus. Martin a signé.";
    const entities = detectSensitiveData(text, settings());
    const result = anonymizeText(text, entities);
    // « Martin » seul peut désigner l'un ou l'autre : marqueur distinct.
    expect(result.text).toBe("[PERSONNE_1] et [PERSONNE_2] sont venus. [PERSONNE_3] a signé.");
  });
});

describe("e-mails, téléphones et adresses", () => {
  it("distingue un téléphone d'une référence de commande au même format", () => {
    expect(masked("Rappelle-moi au 06 12 34 56 78.")).toEqual(["PHONE:06 12 34 56 78"]);
    expect(masked("Ma commande n° 0612345678 est en retard.")).toEqual([]);
    expect(kept("Ma commande n° 0612345678 est en retard.")).toEqual(["REFERENCE:0612345678"]);
  });

  it("généralise une adresse : la voie est masquée, la ville reste", () => {
    const { sanitized } = run("J'habite au 12 rue des Lilas, 75011 Paris : quelle pharmacie est ouverte ?");
    expect(sanitized).toBe("J'habite au [ADRESSE_1], 75011 Paris : quelle pharmacie est ouverte ?");
  });

  it("garde l'adresse d'un itinéraire, sauf le domicile annoncé", () => {
    expect(masked("Itinéraire du 10 rue de Rivoli au musée d'Orsay ?")).toEqual([]);
    expect(masked("J'habite 5 chemin des Vignes, 69005 Lyon, quel itinéraire vers la gare ?")).toEqual([
      "ADDRESS:5 chemin des Vignes",
    ]);
  });

  it("ne prend pas un nombre suivi d'un nom commun pour une adresse", () => {
    expect(masked("J'ai 3 cours de yoga et 2 places de parking.")).toEqual([]);
  });
});

describe("identifiants administratifs et bancaires", () => {
  it("décide d'un NIR sans clé selon le contexte", () => {
    expect(masked("NIR 1850578006084")).toEqual(["SSN_FR:1850578006084"]);
    expect(masked("Ticket 1850578006084 fermé")).toEqual([]);
  });

  it("repère passeport, SSN américain et date de naissance", () => {
    expect(masked("Passeport 18AB12345, né le 14/02/1987.")).toEqual([
      "NATIONAL_ID:18AB12345",
      "DATE_OF_BIRTH:14/02/1987",
    ]);
    expect(masked("My SSN is 078-05-1120.")).toEqual(["NATIONAL_ID:078-05-1120"]);
  });

  it("masque un IBAN annoncé même si sa clé est fausse (faute de frappe)", () => {
    expect(masked("IBAN FR76 3000 6000 0112 3456 7890 188")).toHaveLength(1);
    expect(masked("Code FR76 3000 6000 0112 3456 7890 188")).toEqual([]);
  });

  it("n'appelle carte bancaire qu'un numéro Luhn d'un émetteur connu", () => {
    expect(masked("Carte 5555 5555 5555 4444")).toEqual(["CREDIT_CARD:5555 5555 5555 4444"]);
    // Code EAN-13 valide au sens de Luhn, mais aucun réseau de cartes ne commence par 1.
    expect(masked("Référence produit 1234567890128")).toEqual([]);
  });

  it("masque un identifiant client mais garde une référence de facture", () => {
    const { sanitized } = run("Facture FA-2024-0042, numéro client 482915 : rédige une réclamation.");
    expect(sanitized).toBe("Facture FA-2024-0042, numéro client [IDENTIFIANT_DOSSIER_1] : rédige une réclamation.");
  });

  it("masque aussi les références métier en niveau maximal", () => {
    expect(masked("Facture FA-2024-0042 impayée", "maximum")).toEqual(["REFERENCE:FA-2024-0042"]);
  });
});

describe("secrets et authentification", () => {
  it.each([
    ["Authorization: Bearer abcDEF123ghiJKL456mnoPQR789", "abcDEF123ghiJKL456mnoPQR789"],
    ['{"password": "Pa ss w0rd"}', "Pa ss w0rd"],
    ["secret_key = 'Zx9!kLm2#Qp'", "Zx9!kLm2#Qp"],
    ["STRIPE_KEY=rk_live_abcdefghijklmnop12", "rk_live_abcdefghijklmnop12"],
    ["Mon mot de passe Wi-Fi est Tr0ub4dor&3", "Tr0ub4dor&3"],
    ["Le code PIN de ma carte est 4821", "4821"],
    ["hf_abcdefghijklmnopqrstuvwxyz0123456789", "hf_abcdefghijklmnopqrstuvwxyz0123456789"],
  ])("ne laisse jamais passer « %s »", (text, value) => {
    const { sanitized, protection } = run(text);
    expect(sanitized).not.toContain(value);
    expect(sanitized).toContain("[SECRET_1]");
    expect(protection.verified).toBe(true);
  });

  it.each([
    "Mon mot de passe est expiré, comment le réinitialiser ?",
    "The password is incorrect after the update.",
    "const config = { max_tokens: 1500, password: process.env.DB_PASS };",
    "token count is 1500",
    "Le token JWT expire après 3600 secondes.",
    "interface Login { password: string }",
  ])("ne voit pas de secret dans « %s »", (text) => {
    expect(detectSecrets(text)).toEqual([]);
  });

  it("analyse les secrets même si la catégorie est décochée", () => {
    expect(detectSensitiveData("token: abcdef123456", { categories: [] })).toHaveLength(1);
  });

  it("verrouille toujours les secrets dans la revue, même hors mode strict", () => {
    const [secret] = detectSensitiveData("password=s3cr3tValue");
    expect(isLocked(secret, false)).toBe(true);
    const [email] = detectSensitiveData("a@b.fr");
    expect(isLocked(email, false)).toBe(false);
    expect(isLocked(email, true)).toBe(true);
  });

  it("bloque l'envoi si l'utilisateur tente de garder un secret", () => {
    const text = "password=s3cr3tValue";
    const [secret] = detectSensitiveData(text);
    const protection = protect(text, [], settings(), createAliasRegistry(), [secret]);
    expect(protection.verified).toBe(false);
    expect(protection.issues.map((issue) => issue.code)).toContain("secret_present");
    // Le message d'erreur ne cite jamais la valeur.
    expect(protection.issues.map((issue) => issue.message).join(" ")).not.toContain("s3cr3tValue");
  });
});

describe("préservation de la tâche", () => {
  it("garde les montants d'un calcul budgétaire et le verbe d'action", () => {
    const text = "Calcule mon budget : loyer 850 €, courses 320 €, sur un salaire de 2 100 €.";
    const { sanitized, analysis } = run(text);
    expect(sanitized).toBe(text);
    expect(analysis.task.kinds).toContain("calculation");
    expect(analysis.task.action?.value).toBe("Calcule");
    expect(analysis.task.parameters.map((parameter) => parameter.value)).toEqual(["850 €", "320 €", "2 100 €"]);
  });

  it("n'autorise pas l'IA de contexte à masquer un montant nécessaire au calcul", () => {
    const text = "Mon salaire de 3 200 € augmente de 12 %, calcule le nouveau montant.";
    const excerpt = "salaire de 3 200 € augmente de 12 %";
    const start = text.indexOf(excerpt);
    const findings: AiFindings = {
      ner: null,
      verdict: { risk: "high", reason: "", excerpts: [{ value: excerpt, start, end: start + excerpt.length }] },
      timings: {},
    };
    const { sanitized } = run(text, { findings });
    expect(sanitized).toContain("3 200 €");
    expect(sanitized).toContain("12 %");
  });

  it("garde dates, heures et durées d'un rendez-vous", () => {
    const { sanitized } = run("Propose un créneau à Dr Bernard le 15 mars entre 9h et 11h30, durée 45 minutes.");
    expect(sanitized).toBe("Propose un créneau à Dr [PERSONNE_1] le 15 mars entre 9h et 11h30, durée 45 minutes.");
  });

  it("garde les compétences d'un CV en masquant l'identité", () => {
    const { sanitized } = run("Améliore mon CV : Sophie Lambert, 8 ans de Python et SQL, certifiée PMP.");
    expect(sanitized).toBe("Améliore mon CV : [PERSONNE_1], 8 ans de Python et SQL, certifiée PMP.");
  });

  it("garde l'information médicale utile et dissocie l'identité de l'enfant", () => {
    const { sanitized, analysis } = run("Mon fils Lucas, 6 ans, prend 250 mg de paracétamol, est-ce trop ?");
    expect(sanitized).toBe("Mon fils [PERSONNE_1], 6 ans, prend 250 mg de paracétamol, est-ce trop ?");
    expect(analysis.task.sensitiveContexts).toEqual(expect.arrayContaining(["health", "children"]));
  });

  it("garde codes d'erreur, versions et modèles d'appareil", () => {
    const text = "Erreur 0x80070005 lors de la mise à jour de Windows 11 version 23H2 sur un Dell XPS 13, que faire ?";
    expect(run(text).sanitized).toBe(text);
    expect(masked("Code erreur 0612345678 au démarrage")).toEqual([]);
  });

  it("garde une IP privée utile au dépannage, masque une IP publique", () => {
    expect(masked("Le serveur 192.168.1.20 ne répond plus")).toEqual([]);
    expect(masked("Notre API sur 203.0.113.45 renvoie 502")).toEqual(["IP_ADDRESS:203.0.113.45"]);
  });

  it("traduit et résume sans casser la ponctuation, les guillemets ni les accents", () => {
    const text = "Traduis : « Bonjour Hélène, rendez-vous à 9h ! » — merci.";
    const { sanitized } = run(text);
    expect(sanitized).toBe("Traduis : « Bonjour [PERSONNE_1], rendez-vous à 9h ! » — merci.");
  });

  it("signale (sans bloquer) une sélection qui masquerait la consigne", () => {
    const text = "Calcule 12 + 30.";
    const entities: SensitiveEntity[] = [{ type: "CUSTOM_TERM", value: "Calcule", start: 0, end: 7 }];
    const protection = protect(text, entities, settings(), createAliasRegistry());
    expect(protection.issues.map((issue) => issue.code)).toContain("action_lost");
    expect(protection.verified).toBe(true);
  });
});

describe("marqueurs", () => {
  it("utilise des marqueurs typés qui ne révèlent pas la valeur", () => {
    const text = "Écris à jean.dupont@exemple.fr (06 12 34 56 78), IBAN FR7630006000011234567890189, mdp: Azerty123";
    const { sanitized } = run(text);
    expect(sanitized).toBe("Écris à [EMAIL_1] ([TELEPHONE_1]), IBAN [IBAN_1], mdp: [SECRET_1]");
    expectCleanMarkers(sanitized, ["jean.dupont", "Azerty123"]);
  });

  it("ne réutilise jamais un marqueur déjà écrit par l'utilisateur", () => {
    const { sanitized, protection } = run("Remplace [EMAIL_1] par julie.roux@exemple.fr dans ce modèle.");
    expect(sanitized).toBe("Remplace [EMAIL_1] par [EMAIL_2] dans ce modèle.");
    expect(protection.verified).toBe(true);
  });

  it("reste cohérent d'un message à l'autre et retrouve une valeur déjà masquée", () => {
    const aliases = createAliasRegistry();
    run("Mme Durand a appelé.", { aliases });
    // Second message : « Durand » sans civilité, la mémoire de session le retrouve.
    const { sanitized } = run("Réponds à Durand demain.", { aliases });
    expect(sanitized).toBe("Réponds à [PERSONNE_1] demain.");
  });

  it("restaure la forme la plus complète d'un alias partagé", () => {
    const aliases = createAliasRegistry();
    run("Jeanne Dupont a écrit, Dupont attend.", { aliases });
    expect(restoreText("Merci [PERSONNE_1].", aliases).text).toBe("Merci Jeanne Dupont.");
  });
});

describe("validation indépendante", () => {
  const text = "Écris à a@b.fr demain.";
  const base = () => {
    const entities = detectSensitiveData(text);
    return { entities, result: anonymizeText(text, entities, createAliasRegistry()) };
  };

  it("accepte une transformation fidèle", () => {
    const { result } = base();
    expect(validateTransformation({ original: text, sanitized: result.text, spans: result.spans, settings: settings() })).toEqual([]);
  });

  it("détecte un texte altéré en dehors des remplacements", () => {
    const { result } = base();
    const issues = validateTransformation({
      original: text,
      sanitized: result.text.replace("demain", "aujourd'hui"),
      spans: result.spans,
      settings: settings(),
    });
    expect(issues.map((issue) => issue.code)).toContain("corrupted");
  });

  it("détecte un marqueur qui désigne deux valeurs différentes", () => {
    const original = "a@b.fr et c@d.fr";
    const spans = [
      { type: "EMAIL" as const, original: "a@b.fr", alias: "[EMAIL_1]", start: 0, end: 6, outputStart: 0 },
      { type: "EMAIL" as const, original: "c@d.fr", alias: "[EMAIL_1]", start: 10, end: 16, outputStart: 13 },
    ];
    const issues = validateTransformation({ original, sanitized: "[EMAIL_1] et [EMAIL_1]", spans, settings: settings() });
    expect(issues.map((issue) => issue.code)).toContain("marker_inconsistent");
  });

  it("détecte une valeur de la table de correspondance réintroduite à côté de son marqueur", () => {
    const aliases = createAliasRegistry();
    anonymizeText("Marc", [{ type: "PERSON", value: "Marc", start: 0, end: 4 }], aliases);
    const issues = validateTransformation({
      original: "Voir [PERSONNE_1] et Marc",
      sanitized: "Voir [PERSONNE_1] et Marc",
      spans: [],
      settings: settings(),
      aliases,
    });
    expect(issues.map((issue) => issue.code)).toContain("masked_value_present");
  });

  it("complète automatiquement une occurrence oubliée (seconde passe sûre)", () => {
    const value = "Projet Atlas";
    const config = { ...settings(), customTerms: [value] };
    const original = "Projet Atlas avance ; Projet Atlas recrute.";
    const first: SensitiveEntity = { type: "CUSTOM_TERM", value, start: 0, end: value.length };
    const protection = protect(original, [first], config, createAliasRegistry());
    expect(protection).toMatchObject({ retried: true, verified: true });
    expect(protection.sanitized).toBe("[TERME_CONFIDENTIEL_1] avance ; [TERME_CONFIDENTIEL_1] recrute.");
  });
});

describe("cas limites", () => {
  it.each(["", "   ", "\n\n", "[PERSONNE_1]", "🙂🙂", "a".repeat(5000)])("ne plante pas sur %j", (text) => {
    expect(() => run(text)).not.toThrow();
    expect(run(text).protection.verified).toBe(true);
  });

  it("traite les accents décomposés (NFD) sans perdre la détection", () => {
    const text = "Je m'appelle Hélène Dupré.";
    expect(run(text).sanitized).toBe("Je m'appelle [PERSONNE_1].");
  });

  it("reste rapide sur un long message", () => {
    const text = "Point : budget de 14 000 €, contact claire.f@exemple.fr, ticket INC-2231. ".repeat(60);
    const started = performance.now();
    const { protection } = run(text);
    expect(protection.verified).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("repère l'intention d'un message court ou ambigu", () => {
    expect(analyzeTask("Traduis : bonjour").kinds).toContain("translation");
    expect(analyzeTask("ok").kinds).toEqual([]);
  });
});
