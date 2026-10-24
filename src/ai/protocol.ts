import type { AiFindings } from "../engine/analysis";

export type ModelKind = "ner" | "llm";

export type ModelState =
  | { state: "idle" }
  | { state: "loading"; progress: number | null }
  | { state: "ready"; device: "webgpu" | "wasm" }
  | { state: "error"; error: string };

export type AiStatus = {
  /** null tant que la présence de WebGPU n'a pas été vérifiée. */
  webgpu: boolean | null;
  ner: ModelState;
  llm: ModelState;
};

export type AnalyzeRequest = { type: "analyze"; text: string; ner: boolean; llm: boolean };
export type LoadRequest = { type: "load"; ner: boolean; llm: boolean };
export type StatusRequest = { type: "status" };
export type AiRequest = AnalyzeRequest | LoadRequest | StatusRequest;

export type AnalyzeResponse = { ok: true; findings: AiFindings } | { ok: false; error: string };

/** Enveloppe : `target` évite que le background et l'offscreen répondent au même message. */
export type Envelope = AiRequest & { target: "background" | "offscreen" };

export const IDLE_STATUS: AiStatus = { webgpu: null, ner: { state: "idle" }, llm: { state: "idle" } };
