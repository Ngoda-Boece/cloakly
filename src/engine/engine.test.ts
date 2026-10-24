import { describe, expect, it } from "vitest";
import { anonymizeText, createAliasRegistry } from "./anonymize";
import { detectSensitiveData, luhn, type EntityType } from "./detect";
import { protect, verifyEditorContent } from "./protect";

const ALL = { categories: ["personal", "professional", "secrets", "confidential"] as const, customTerms: [] };

function types(text: string, options = {}): EntityType[] {
  return detectSensitiveData(text, options).map((entity) => entity.type);
}

function values(text: string, options = {}): string[] {
  return detectSensitiveData(text, options).map((entity) => entity.value);
}

describe("detectSensitiveData — données personnelles", () => {
  it("détecte les e-mails", () => {
    expect(values("Écris à jean.dupont+test@exemple.co.uk demain.")).toEqual([
      "jean.dupont+test@exemple.co.uk",
    ]);
  });

  it.each([
    "06 12 34 56 78",
    "06.12.34.56.78",
    "0612345678",
    "+33 6 12 34 56 78",
    "+33612345678",
    "0033 6 12 34 56 78",
    "+44 20 7946 0958",
  ])("détecte le téléphone %s", (phone) => {
    expect(detectSensitiveData(`Appelle-moi au ${phone} stp`)).toMatchObject([
      { type: "PHONE", value: phone },
    ]);
  });

  it("ne confond pas dates, années ou petits nombres avec des téléphones", () => {
    expect(types("Réunion le 2024-01-15 à 14h30, budget 125000 euros, version 1.2.3")).toEqual([]);
  });

  it("détecte un IBAN valide, avec ou sans espaces", () => {
    expect(values("IBAN : FR76 3000 6000 0112 3456 7890 189 merci")).toEqual([
      "FR76 3000 6000 0112 3456 7890 189",
    ]);
    expect(types("FR7630006000011234567890189")).toEqual(["IBAN"]);
  });

  it("ignore un IBAN dont la clé est fausse", () => {
    expect(types("FR76 3000 6000 0112 3456 7890 188")).not.toContain("IBAN");
  });

  it("détecte une carte bancaire valide (Luhn) et ignore une invalide", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(types("Carte 4111 1111 1111 1111 exp 12/27")).toEqual(["CREDIT_CARD"]);
    expect(types("Commande 4111 1111 1111 1112")).toEqual([]);
  });

  it("détecte un numéro de sécurité sociale avec clé valide", () => {
    expect(values("NIR 1 85 05 78 006 084 91.")).toEqual(["1 85 05 78 006 084 91"]);
    expect(types("NIR 2 69 05 2A 123 456 88")).toEqual(["SSN_FR"]);
    // Clé fausse et aucun libellé : ce n'est pas un NIR.
    expect(types("1 85 05 78 006 084 90")).not.toContain("SSN_FR");
    // Clé fausse mais annoncé comme NIR : une faute de frappe identifie quand même la personne.
    expect(types("NIR 1 85 05 78 006 084 90")).toContain("SSN_FR");
  });
});

describe("detectSensitiveData — données professionnelles et secrets", () => {
  it("détecte les adresses IP valides seulement", () => {
    expect(values("Serveur 203.0.113.10, pas 999.1.1.1.")).toEqual(["203.0.113.10"]);
  });

  it("détecte les URL internes mais pas les URL publiques", () => {
    expect(values("Voir https://wiki.acme.internal/page?id=3 et https://example.com")).toEqual([
      "https://wiki.acme.internal/page?id=3",
    ]);
    // localhost ne révèle rien et sert au débogage.
    expect(types("http://localhost:3000/admin")).toEqual([]);
  });

  it.each([
    ["Anthropic", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"],
    ["OpenAI", "sk-proj-abcdefghijklmnopqrstuvwxyz0123"],
    ["GitHub", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["AWS", "AKIAIOSFODNN7EXAMPLE"],
    ["Stripe", "sk_live_abcdefghijklmnop1234"],
  ])("détecte une clé d'API %s", (_name, key) => {
    expect(detectSensitiveData(`clé ${key} ici`)).toMatchObject([{ type: "API_KEY", value: key }]);
  });

  it("détecte un JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(types(`Bearer ${jwt}`)).toEqual(["JWT"]);
  });

  it("détecte un bloc de clé privée complet", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(values(`Voici la clé :\n${key}\nfin`)).toEqual([key]);
  });

  it("ne masque que la valeur d'un mot de passe", () => {
    expect(detectSensitiveData("Mon mot de passe : Hunter2024!")).toMatchObject([
      { type: "PASSWORD", value: "Hunter2024!" },
    ]);
    expect(values("password=s3cr3tValue")).toEqual(["s3cr3tValue"]);
  });

  it("masque le mot de passe d'une chaîne de connexion", () => {
    expect(values("postgres://admin:SuperSecret@db.example.com:5432/app")).toEqual(["SuperSecret"]);
  });
});

describe("detectSensitiveData — options", () => {
  it("détecte les termes confidentiels personnalisés sans tenir compte de la casse", () => {
    expect(
      detectSensitiveData("Le projet atlas avance, contacter Marie Curie.", {
        customTerms: ["Projet Atlas", "Marie Curie", " "],
      })
    ).toMatchObject([
      { type: "CUSTOM_TERM", value: "projet atlas" },
      { type: "CUSTOM_TERM", value: "Marie Curie" },
    ]);
  });

  it("respecte les limites de mots pour les termes personnalisés", () => {
    expect(types("Atlassian n'est pas concerné", { customTerms: ["Atlas"] })).toEqual([]);
  });

  it("n'analyse que les catégories activées, sauf les secrets toujours analysés", () => {
    const text = "mail a@b.fr, IP 8.8.4.4, token: abcdef123456";
    expect(types(text, { categories: ["professional"] })).toEqual(["IP_ADDRESS", "PASSWORD"]);
    expect(types(text, { categories: [] })).toEqual(["PASSWORD"]);
    expect(types(text)).toEqual(["EMAIL", "IP_ADDRESS", "PASSWORD"]);
  });

  it("ne renvoie jamais de détections qui se chevauchent", () => {
    const entities = detectSensitiveData("password: sk-proj-abcdefghijklmnopqrstuvwxyz0123 et 8.8.4.4", {
      customTerms: ["proj"],
    });
    for (let index = 1; index < entities.length; index += 1) {
      expect(entities[index].start).toBeGreaterThanOrEqual(entities[index - 1].end);
    }
    expect(entities.map((entity) => entity.type)).toEqual(["API_KEY", "IP_ADDRESS"]);
  });
});

describe("anonymizeText", () => {
  it("remplace les valeurs par des alias numérotés dans l'ordre d'apparition", () => {
    const text = "a@x.fr puis b@x.fr";
    const result = anonymizeText(text, detectSensitiveData(text));
    expect(result.text).toBe("[EMAIL_1] puis [EMAIL_2]");
    expect(result.replacements).toEqual([
      { type: "EMAIL", original: "a@x.fr", alias: "[EMAIL_1]" },
      { type: "EMAIL", original: "b@x.fr", alias: "[EMAIL_2]" },
    ]);
  });

  it("pseudonymise de façon cohérente entre plusieurs messages", () => {
    const aliases = createAliasRegistry();
    const first = "Contacte A@X.fr au 06 12 34 56 78";
    const second = "Rappel : a@x.fr, nouveau b@x.fr, tel +33 6 12 34 56 78";

    expect(anonymizeText(first, detectSensitiveData(first), aliases).text).toBe(
      "Contacte [EMAIL_1] au [TELEPHONE_1]"
    );
    expect(anonymizeText(second, detectSensitiveData(second), aliases).text).toBe(
      "Rappel : [EMAIL_1], nouveau [EMAIL_2], tel [TELEPHONE_1]"
    );
  });

  it("refuse des entités qui se chevauchent", () => {
    expect(() =>
      anonymizeText("abcdef", [
        { type: "EMAIL", value: "abcd", start: 0, end: 4 },
        { type: "EMAIL", value: "cdef", start: 2, end: 6 },
      ])
    ).toThrow();
  });
});

describe("protect", () => {
  it("produit un texte pseudonymisé vérifié", () => {
    const text = "Envoie le rapport à paul@acme.fr, IBAN FR7630006000011234567890189, mdp: Azerty123";
    const result = protect(text, detectSensitiveData(text), ALL, createAliasRegistry());
    expect(result).toMatchObject({
      sanitized: "Envoie le rapport à [EMAIL_1], IBAN [IBAN_1], mdp: [SECRET_1]",
      verified: true,
    });
  });

  it("complète par une seconde passe une donnée ni sélectionnée ni explicitement gardée", () => {
    const text = "a@b.fr et c@d.fr";
    const [first, second] = detectSensitiveData(text);
    const completed = protect(text, [first], ALL, createAliasRegistry());
    expect(completed).toMatchObject({ sanitized: "[EMAIL_1] et [EMAIL_2]", retried: true, verified: true });
    const kept = protect(text, [first], ALL, createAliasRegistry(), [second]);
    expect(kept).toMatchObject({ sanitized: "[EMAIL_1] et c@d.fr", retried: false, verified: true });
  });

  it("vérifie le contenu relu depuis l'éditeur", () => {
    expect(verifyEditorContent("Bonjour\n\n[EMAIL_1]", "Bonjour [EMAIL_1]", ALL)).toBe(true);
    expect(verifyEditorContent("Bonjour a@b.fr [EMAIL_1]", "Bonjour [EMAIL_1]", ALL)).toBe(false);
    expect(verifyEditorContent("Bonjour", "Bonjour [EMAIL_1]", ALL)).toBe(false);
  });

  it("refuse un contenu où une valeur masquée par l'IA est encore présente", () => {
    expect(verifyEditorContent("Voir [PERSON_1] et Marc", "Voir [PERSON_1] et Marc", ALL, ["Marc"])).toBe(false);
    expect(verifyEditorContent("Voir [PERSON_1] et Marcel", "Voir [PERSON_1] et Marcel", ALL, ["Marc"])).toBe(true);
  });
});
