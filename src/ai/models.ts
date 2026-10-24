import type { ModelKind } from "./protocol";

export type ModelConfig = {
  id: string;
  label: string;
  /** Taille approximative du téléchargement, affichée dans le popup. */
  sizeMb: number;
  dtype: { webgpu: string; wasm: string };
};

// Les modèles ont été évalués sur des messages français types
// (npm run eval:ai) : Gemma-3-1B l'a emporté sur Qwen2.5-0.5B, Qwen3-0.6B et
// LFM2-700M, avec des extraits courts et précis et peu de faux positifs.
export const MODELS: Record<ModelKind, ModelConfig> = {
  ner: {
    id: "Xenova/distilbert-base-multilingual-cased-ner-hrl",
    label: "Noms, organisations et lieux",
    sizeMb: 135,
    dtype: { webgpu: "q8", wasm: "q8" },
  },
  llm: {
    id: "onnx-community/gemma-3-1b-it-ONNX",
    label: "Analyse du contexte",
    sizeMb: 760,
    dtype: { webgpu: "q4f16", wasm: "q4f16" },
  },
};
