// Passe des messages complexes dans la chaîne complète de Cloakly (règles + NER + LLM + filtres)
// et montre chaque étape : réponse brute du LLM, verdict retenu, texte finalement envoyé.
// Usage : npm run eval:pipeline
import { pipeline } from "@huggingface/transformers";
import { combineDetections, needsContextAnalysis } from "../src/engine/analysis.ts";
import { anonymizeText } from "../src/engine/anonymize.ts";
import { buildMessages, parseVerdict } from "../src/engine/llmPrompt.ts";
import { locateNerGroups, splitForNer } from "../src/engine/ner.ts";
import { expandOccurrences } from "../src/engine/protect.ts";

export const SAMPLES = [
  ["D1", "Peux-tu reformuler : nous confirmons le rachat de Biocoop prévu le 15 mars, merci de ne pas en parler avant l'annonce officielle."],
  ["D2", "Résume : le salaire de Julien passera à 85 000 € en janvier et Claire est en arrêt maladie pour dépression."],
  ["D3", "Notre chiffre d'affaires du T3, non publié, est de 12,4 M€, en baisse de 18 %, le conseil envisage de fermer une usine."],
  ["D4", "Le plan social prévoit 120 suppressions de postes sur le site de production, l'annonce aux syndicats est prévue le 3 juin, ne le diffuse pas."],
  ["D5", "Notre client est poursuivi pour fraude fiscale, l'audience est fixée au 12 avril, aide-moi à préparer sa défense."],
  ["D6", "Le mot de passe admin du VPN est toujours celui par défaut et le pare-feu du serveur de paie est désactivé depuis lundi."],
  ["E1", "Bonjour, peux-tu améliorer ce compte rendu ? Réunion avec Sophie Lambert (sophie.lambert@capgemini.com) et Marc Dubois : nous confirmons le rachat de Biocoop pour 40 M€, signature prévue le 15 mars, à ne pas ébruiter avant l'annonce."],
  ["A1", "Explique-moi la différence entre TCP et UDP avec un exemple concret."],
  ["A6", "Comment Napoléon a-t-il perdu la bataille de Waterloo ?"],
  ["A7", "Écris un mail de relance poli à un fournisseur dont la livraison a deux jours de retard."],
];

const settings = {
  categories: ["personal", "professional", "secrets", "confidential", "identities", "context"],
  customTerms: [],
};

const only = process.argv[2];
const ner = await pipeline("token-classification", "Xenova/distilbert-base-multilingual-cased-ner-hrl", { dtype: "q8" });
const llm = await pipeline("text-generation", process.env.LLM ?? "onnx-community/gemma-3-1b-it-ONNX", { dtype: "q4f16" });

for (const [id, text] of SAMPLES) {
  if (only && !only.split(",").includes(id)) continue;
  const nerEntities = [];
  for (const chunk of splitForNer(text)) {
    nerEntities.push(...locateNerGroups(chunk, await ner(chunk.text, { aggregation_strategy: "simple" })));
  }
  let verdict = null;
  let reply = "(LLM non appelé : message trop court)";
  const t = performance.now();
  if (needsContextAnalysis(text)) {
    const out = await llm(buildMessages(text), { max_new_tokens: 160, do_sample: false });
    reply = out[0].generated_text.at(-1).content.trim();
    verdict = parseVerdict(reply, text);
  }
  const ms = Math.round(performance.now() - t);
  const findings = { ner: nerEntities.filter((e) => e.type !== "LOCATION"), verdict, timings: {} };
  const entities = expandOccurrences(text, combineDetections(text, settings, findings));
  const llmKept = entities.filter((e) => e.source === "llm").map((e) => e.value);

  console.log(`\n===== ${id} (${ms} ms LLM)\n${text}`);
  console.log(`--- réponse brute :\n${reply}`);
  console.log(`--- verdict retenu : ${verdict?.risk} | extraits vérifiés : ${JSON.stringify(verdict?.excerpts.map((e) => e.value) ?? [])}`);
  console.log(`--- extraits LLM gardés après filtres : ${JSON.stringify(llmKept)}`);
  console.log(`--- envoyé : ${entities.length ? anonymizeText(text, entities).text : "(aucune fenêtre, envoi direct)"}`);
}
