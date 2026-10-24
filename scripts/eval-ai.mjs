// Évalue les modèles IA locaux de Cloakly sur des messages types (Node, CPU).
// Usage : node scripts/eval-ai.mjs [ner|llm|all]
import { pipeline } from "@huggingface/transformers";

const SAMPLES = [
  "Peux-tu reformuler ce mail : Bonjour Marc, suite à notre réunion avec Sophie Lambert de chez Danone, nous confirmons le rachat de Biocoop prévu le 15 mars. Merci de ne pas en parler avant l'annonce officielle.",
  "Résume : le salaire de Julien Moreau passera à 85 000 € en janvier, et Claire Petit est en arrêt maladie pour dépression depuis deux semaines.",
  "Explique-moi la différence entre TCP et UDP.",
  "Écris un poème sur Paris au printemps.",
  "Notre chiffre d'affaires du T3 (non publié) est de 12,4 M€, en baisse de 18 %. Le conseil envisage de fermer l'usine de Grenoble.",
  "Comment Napoléon a-t-il perdu à Waterloo ?",
];

const mode = process.argv[2] ?? "all";

if (mode !== "llm") {
  const t0 = performance.now();
  const ner = await pipeline("token-classification", "Xenova/distilbert-base-multilingual-cased-ner-hrl", { dtype: "q8" });
  console.log(`NER chargé en ${Math.round(performance.now() - t0)} ms`);
  for (const text of SAMPLES) {
    const t = performance.now();
    const out = await ner(text, { aggregation_strategy: "simple" });
    console.log(`\n[${Math.round(performance.now() - t)} ms] ${text.slice(0, 60)}…`);
    console.log(out.map((e) => `${e.entity_group}:${e.word}(${e.score.toFixed(2)})`).join(" | ") || "—");
  }
}

if (mode !== "ner") {
  const model = process.env.LLM ?? "onnx-community/gemma-3-1b-it-ONNX";
  const t0 = performance.now();
  const llm = await pipeline("text-generation", model, { dtype: process.env.DTYPE ?? "q4f16" });
  console.log(`\nLLM ${model} chargé en ${Math.round(performance.now() - t0)} ms`);
  const { buildMessages, parseVerdict } = await import("../src/engine/llmPrompt.ts");
  for (const text of SAMPLES) {
    const t = performance.now();
    const messages = buildMessages(text);
    // Qwen3 : désactive le mode « réflexion », trop lent pour un usage interactif.
    if (/qwen3/i.test(model)) messages.at(-1).content += " /no_think";
    const out = await llm(messages, { max_new_tokens: 160, do_sample: false });
    const reply = out[0].generated_text.at(-1).content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const verdict = parseVerdict(reply, text);
    console.log(`\n[${Math.round(performance.now() - t)} ms] ${text.slice(0, 60)}…\n${reply}`);
    console.log(`→ retenu par Cloakly : risque ${verdict.risk}, extraits ${JSON.stringify(verdict.excerpts.map((e) => e.value))}`);
  }
}
