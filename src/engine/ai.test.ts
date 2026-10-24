import { describe, expect, it } from "vitest";
import { analyzeMessage, combineDetections, needsContextAnalysis, type AiFindings } from "./analysis";
import { anonymizeText, createAliasRegistry, restoreText, serializeRegistry } from "./anonymize";
import type { SensitiveEntity } from "./detect";
import { alignExcerpt, buildMessages, parseVerdict } from "./llmPrompt";
import { locateNerGroups, splitForNer } from "./ner";
import { expandOccurrences } from "./protect";

const ALL = {
  categories: ["personal", "professional", "secrets", "confidential", "identities", "context"] as const,
  customTerms: [],
};

function findings(partial: Partial<AiFindings>): AiFindings {
  return { ner: null, verdict: null, timings: {}, ...partial };
}

describe("locateNerGroups", () => {
  // Sorties réelles du modèle Xenova/distilbert-base-multilingual-cased-ner-hrl.
  const text =
    "Bonjour Marc, suite à notre réunion avec Sophie Lambert de chez Danone, nous confirmons le rachat de Biocoop.";
  const groups = [
    { entity_group: "PER", score: 0.99, word: "Marc" },
    { entity_group: "PER", score: 1, word: "Sophie Lambert" },
    { entity_group: "LOC", score: 0.99, word: "Danone" },
    { entity_group: "ORG", score: 1, word: "Biocoop" },
  ];

  it("retrouve la position exacte de chaque entité", () => {
    expect(locateNerGroups({ text, offset: 0 }, groups)).toMatchObject([
      { type: "PERSON", value: "Marc", start: 8, source: "ner" },
      { type: "PERSON", value: "Sophie Lambert", start: text.indexOf("Sophie") },
      { type: "LOCATION", value: "Danone" },
      { type: "ORGANIZATION", value: "Biocoop" },
    ]);
  });

  it("tolère les espaces ajoutés par le décodage et applique le décalage du morceau", () => {
    const [entity] = locateNerGroups({ text: "Voir Jean-Pierre Dupont.", offset: 100 }, [
      { entity_group: "PER", score: 0.95, word: "Jean - Pierre Dupont" },
    ]);
    expect(entity).toMatchObject({ value: "Jean-Pierre Dupont", start: 105, end: 123 });
  });

  it("écarte les entités peu sûres, inconnues ou introuvables", () => {
    expect(
      locateNerGroups({ text: "Bonjour Marc", offset: 0 }, [
        { entity_group: "PER", score: 0.4, word: "Marc" },
        { entity_group: "MISC", score: 0.99, word: "Marc" },
        { entity_group: "PER", score: 0.99, word: "Paul" },
        { entity_group: "PER", score: 0.99, word: "[UNK]" },
      ])
    ).toEqual([]);
  });

  it("ne confond pas un prénom avec le début d'un autre mot", () => {
    expect(
      locateNerGroups({ text: "Marcel et Marc", offset: 0 }, [{ entity_group: "PER", score: 0.9, word: "Marc" }])
    ).toMatchObject([{ start: 10 }]);
  });
});

describe("splitForNer", () => {
  it("découpe en morceaux couvrant tout le texte, de préférence en fin de phrase", () => {
    const text = "Phrase un. ".repeat(200);
    const chunks = splitForNer(text, 300);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(300);
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
    }
    expect(chunks[0].text.endsWith(".")).toBe(true);
  });
});

describe("parseVerdict", () => {
  const text =
    "Notre chiffre d'affaires du T3 (non publié) est de 12,4 M€. Le conseil envisage de fermer l'usine de Grenoble.";

  it("lit le risque, la raison et des extraits présents mot pour mot", () => {
    const verdict = parseVerdict(
      "RISK: high\nREASON: Chiffres non publiés.\nEXCERPTS:\n- chiffre d'affaires du T3 (non publié) est de 12,4 M€\n- le conseil envisage de fermer l'usine de Grenoble.",
      text
    );
    expect(verdict.risk).toBe("high");
    expect(verdict.reason).toBe("Chiffres non publiés.");
    expect(verdict.excerpts.map((excerpt) => excerpt.value)).toEqual([
      "chiffre d'affaires du T3 (non publié) est de 12,4 M€",
      "Le conseil envisage de fermer l'usine de Grenoble",
    ]);
    for (const excerpt of verdict.excerpts) {
      expect(text.slice(excerpt.start, excerpt.end)).toBe(excerpt.value);
    }
  });

  it("rejette les extraits inventés par le modèle (observé avec Qwen3 sur un poème)", () => {
    const verdict = parseVerdict(
      "RISK: none\nREASON: Littérature.\nEXCERPTS:\n- Paris, au printemps, s'éloignait du ciel.",
      "Écris un poème sur Paris au printemps."
    );
    expect(verdict).toEqual({
      risk: "none",
      reason: "Littérature.",
      excerpts: [],
      rejected: ["Paris, au printemps, s'éloignait du ciel"],
    });
  });

  it("rejette un extrait qui couvre tout le message (observé : Napoléon à Waterloo)", () => {
    const question = "Comment Napoléon a-t-il perdu à Waterloo ?";
    const verdict = parseVerdict("RISK: high\nREASON: x\nEXCERPTS: comment napoléon a-t-il perdu à waterloo", question);
    expect(verdict.excerpts).toEqual([]);
  });

  it("résiste à une réponse mal formée", () => {
    expect(parseVerdict("Je ne sais pas.", text)).toEqual({ risk: "none", reason: "", excerpts: [], rejected: [] });
  });

  it("construit un prompt qui contient le message", () => {
    const messages = buildMessages("Mon texte");
    expect(messages[0].role).toBe("system");
    expect(messages.at(-1)?.content).toContain("Mon texte");
  });
});

describe("alignExcerpt — reformulations réelles de Gemma-3-1B", () => {
  it.each([
    [
      "Notre client est poursuivi pour fraude fiscale, l'audience est fixée au 12 avril, aide-moi à préparer sa défense.",
      "poursuite pour fraude fiscale",
      "poursuivi pour fraude fiscale",
    ],
    [
      "Notre client est poursuivi pour fraude fiscale, l'audience est fixée au 12 avril, aide-moi à préparer sa défense.",
      "audience fixée au 12 avril",
      "audience est fixée au 12 avril",
    ],
    [
      "Résume : le salaire de Julien passera à 85 000 € en janvier et Claire est en arrêt maladie pour dépression.",
      "Julien reçoit 85 000 € en janvier",
      "Julien passera à 85 000 € en janvier",
    ],
    [
      "Le plan social prévoit 120 suppressions de postes sur le site de production, l'annonce aux syndicats est prévue le 3 juin, ne le diffuse pas.",
      "annonce aux syndicats le 3 juin",
      "annonce aux syndicats est prévue le 3 juin",
    ],
  ])("rattache un extrait reformulé au passage réel", (text, proposed, expected) => {
    const span = alignExcerpt(proposed, text);
    expect(span && text.slice(span.start, span.end)).toBe(expected);
  });

  it.each([
    ["Explique-moi la différence entre TCP et UDP avec un exemple concret.", "UDP (User Datagram Protocol): Un protocole rapide, non ordonné"],
    ["Écris un mail de relance poli à un fournisseur dont la livraison a deux jours de retard.", "Le fournisseur est une entreprise établie"],
    ["Peux-tu reformuler : nous confirmons le rachat de Biocoop prévu le 15 mars.", "confirmation of the buyback of Biocoop, planned for March 15th"],
  ])("rejette un extrait inventé ou traduit", (text, proposed) => {
    expect(alignExcerpt(proposed, text)).toBeNull();
  });
});

describe("combineDetections", () => {
  it("fusionne règles, NER et contexte en donnant la priorité aux règles", () => {
    const text = "Le salaire de Julien Moreau (julien@acme.fr) passera à 85 000 € en janvier.";
    const ner: SensitiveEntity[] = [
      { type: "PERSON", value: "Julien Moreau", start: 14, end: 27, source: "ner", score: 1 },
      // Le NER se trompe parfois et chevauche un e-mail : la règle l'emporte.
      { type: "PERSON", value: "julien", start: 29, end: 35, source: "ner", score: 0.8 },
    ];
    const excerpt = "salaire de Julien Moreau (julien@acme.fr) passera à 85 000 €";
    const start = text.indexOf(excerpt);
    const verdict = {
      risk: "high" as const,
      reason: "Salaire",
      excerpts: [{ value: excerpt, start, end: start + excerpt.length }],
    };

    const entities = combineDetections(text, ALL, findings({ ner, verdict }));
    expect(entities.map((entity) => [entity.type, entity.value])).toEqual([
      ["PERSON", "Julien Moreau"],
      ["EMAIL", "julien@acme.fr"],
      ["CONFIDENTIAL", "passera à 85 000 €"],
    ]);
  });

  it("ne masque pas les mots de liaison quand le LLM cite tout le message (cas réel, Gemma dans Chromium)", () => {
    const text =
      "Peux-tu reformuler ce mail : Bonjour Marc, suite à notre réunion avec Sophie Lambert, nous confirmons le rachat de Biocoop prévu le 15 mars. Écris-moi à marc.dupont@exemple.fr.";
    const at = (value: string) => ({ value, start: text.indexOf(value), end: text.indexOf(value) + value.length });
    const ner: SensitiveEntity[] = ["Marc", "Sophie Lambert", "Biocoop"].map((value) => ({
      type: value === "Biocoop" ? "ORGANIZATION" : "PERSON",
      ...at(value),
      source: "ner",
    }));
    const excerpts = [
      at("Bonjour Marc, suite à notre réunion avec Sophie Lambert"),
      at("rachat de Biocoop prévu le 15 mars"),
      at("Écris-moi à marc.dupont@exemple.fr"),
    ];

    const values = (risk: "none" | "medium") =>
      combineDetections(text, ALL, findings({ ner, verdict: { risk, reason: "", excerpts } })).map((e) => e.value);

    // « Bonjour », « suite à notre réunion avec », « Écris-moi à » ne sont pas masqués.
    expect(values("medium")).toEqual(["Marc", "Sophie Lambert", "Biocoop", "prévu le 15 mars", "marc.dupont@exemple.fr"]);
    expect(values("none")).toEqual(["Marc", "Sophie Lambert", "Biocoop", "marc.dupont@exemple.fr"]);
  });

  it("garde entier un extrait qui ne recouvre aucune autre détection", () => {
    const text = "Le plan social prévoit des suppressions de postes, ne le diffuse pas.";
    const value = "plan social prévoit des suppressions de postes";
    const start = text.indexOf(value);
    const entities = combineDetections(
      text,
      ALL,
      findings({ verdict: { risk: "high", reason: "", excerpts: [{ value, start, end: start + value.length }] } })
    );
    expect(entities.map((e) => e.value)).toEqual([value]);
  });

  it("ne masque pas un extrait de contexte générique, sans fait précis", () => {
    const text = "Le bailleur réclame mon numéro allocataire et la copie du bail, écris une réponse polie qui refuse.";
    const at = (value: string) => ({ value, start: text.indexOf(value), end: text.indexOf(value) + value.length });
    const excerpts = [at("numéro allocataire"), at("la copie du bail"), at("réponse polie")];
    expect(combineDetections(text, ALL, findings({ verdict: { risk: "medium", reason: "", excerpts } }))).toEqual([]);
  });

  it.each([
    ["Résume : le rachat de Talvern reste secret, Hugo prévient les équipes.", "rachat de Talvern"],
    ["Reformule : la direction prépare le licenciement de deux cadres du service achats.", "licenciement de deux cadres"],
    ["mets en forme : réunion avec nadia benali demain sur le budget.", "nadia benali"],
    ["Écris à paul.roux [at] exemple [point] fr pour confirmer la livraison.", "paul.roux [at] exemple [point] fr"],
    ["Traduis : nous fermons 3 agences avant l'été, n'en parle à personne.", "nous fermons 3 agences"],
  ])("masque un extrait de contexte qui porte un fait précis (%s)", (text, value) => {
    const start = text.indexOf(value);
    const verdict = { risk: "high" as const, reason: "", excerpts: [{ value, start, end: start + value.length }] };
    expect(combineDetections(text, ALL, findings({ verdict })).map((e) => e.value)).toContain(value);
  });

  it("ne masque pas un extrait dont le seul fait précis est un paramètre de la tâche", () => {
    const text = "Rédige une annonce pour louer ma remorque à 35 € la journée, dispo samedi vers 9h.";
    const at = (value: string) => ({ value, start: text.indexOf(value), end: text.indexOf(value) + value.length });
    const excerpts = [at("remorque à 35 €"), at("dispo samedi vers 9h")];
    expect(combineDetections(text, ALL, findings({ verdict: { risk: "medium", reason: "", excerpts } }))).toEqual([]);
  });

  it("ne masque pas du code cité par le contexte, mais toujours le secret qu'il contient", () => {
    const text = 'Pourquoi ça plante ?\nresp = client.post(API_URL, json={"token": "Zq81!mLp#4vR"})\nprint(resp.json())';
    const at = (value: string) => ({ value, start: text.indexOf(value), end: text.indexOf(value) + value.length });
    const excerpts = [at("resp = client.post(API_URL"), at("print(resp.json())")];
    const values = combineDetections(text, ALL, findings({ verdict: { risk: "high", reason: "", excerpts } })).map((e) => e.value);
    expect(values).toEqual(["Zq81!mLp#4vR"]);
  });

  it("laisse gardé ce que les règles ont choisi de garder, malgré le NER et le contexte", () => {
    const text = "Raconte la vie de Marie Curie, puis relance le colis de la commande n° 77120934 arrivé abîmé.";
    const at = (value: string) => ({ value, start: text.indexOf(value), end: text.indexOf(value) + value.length });
    const ner: SensitiveEntity[] = [{ type: "PERSON", ...at("Marie Curie"), source: "ner" }];
    const excerpts = [at("commande n° 77120934")];
    const analysis = analyzeMessage(text, ALL, findings({ ner, verdict: { risk: "medium", reason: "", excerpts } }));
    expect(analysis.entities).toEqual([]);
    expect(analysis.kept.map((entity) => entity.value)).toEqual(expect.arrayContaining(["Marie Curie", "77120934"]));
  });

  it("respecte les catégories désactivées", () => {
    const text = "Sophie Lambert valide.";
    const ner: SensitiveEntity[] = [
      { type: "PERSON", value: "Sophie Lambert", start: 0, end: 14, source: "ner" },
    ];
    expect(combineDetections(text, { ...ALL, categories: ["personal"] }, findings({ ner }))).toEqual([]);
  });

  it("ignore une entité IA dont la position ne correspond pas au texte", () => {
    const ner: SensitiveEntity[] = [{ type: "PERSON", value: "Paul", start: 0, end: 4, source: "ner" }];
    expect(combineDetections("Le train arrive", ALL, findings({ ner }))).toEqual([]);
  });

  it("ne lance l'analyse de contexte que sur des messages assez longs", () => {
    expect(needsContextAnalysis("Bonjour !")).toBe(false);
    expect(needsContextAnalysis("Le conseil envisage de fermer l'usine de Grenoble en juin.")).toBe(true);
  });
});

describe("expandOccurrences", () => {
  it("masque toutes les occurrences d'une valeur repérée une seule fois par l'IA", () => {
    const text = "Marc a dit à marc que Marcel viendrait. MARC confirme.";
    const entities = expandOccurrences(text, [{ type: "PERSON", value: "Marc", start: 0, end: 4, source: "ner" }]);
    expect(entities.map((entity) => entity.start)).toEqual([0, 13, 40]);
    expect(anonymizeText(text, entities).text).toBe(
      "[PERSONNE_1] a dit à [PERSONNE_1] que Marcel viendrait. [PERSONNE_1] confirme."
    );
  });
});

describe("restoreText", () => {
  it("remet les vraies valeurs dans la réponse de l'IA", () => {
    const aliases = createAliasRegistry();
    const text = "Écris à Sophie Lambert (sophie@acme.fr)";
    anonymizeText(
      text,
      [
        { type: "PERSON", value: "Sophie Lambert", start: 8, end: 22 },
        { type: "EMAIL", value: "sophie@acme.fr", start: 24, end: 38 },
      ],
      aliases
    );

    expect(restoreText("Bonjour [PERSONNE_1], je réponds à [EMAIL_1]. [TELEPHONE_9] inconnu.", aliases)).toEqual({
      text: "Bonjour Sophie Lambert, je réponds à sophie@acme.fr. [TELEPHONE_9] inconnu.",
      restored: 2,
    });
  });

  it("survit à une sérialisation (persistance de session)", () => {
    const aliases = createAliasRegistry();
    anonymizeText("a@b.fr", [{ type: "EMAIL", value: "a@b.fr", start: 0, end: 6 }], aliases);
    const copy = createAliasRegistry(JSON.parse(JSON.stringify(serializeRegistry(aliases))));
    expect(restoreText("[EMAIL_1]", copy).text).toBe("a@b.fr");
    expect(anonymizeText("c@d.fr", [{ type: "EMAIL", value: "c@d.fr", start: 0, end: 6 }], copy).text).toBe("[EMAIL_2]");
  });
});
