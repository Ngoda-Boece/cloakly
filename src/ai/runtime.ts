import { env, pipeline, type ProgressInfo } from "@huggingface/transformers";
import type { AiFindings } from "../engine/analysis";
import type { SensitiveEntity } from "../engine/detect";
import { buildMessages, parseVerdict, type ChatMessage, type ContextVerdict } from "../engine/llmPrompt";
import { locateNerGroups, splitForNer, type NerGroup } from "../engine/ner";
import { MODELS } from "./models";
import type { AiStatus, ModelKind, ModelState } from "./protocol";

// Les modèles viennent de Hugging Face (une seule fois, puis cache du navigateur).
// Le moteur WASM est embarqué dans l'extension : MV3 interdit le code distant,
// et le cache « blob: » de transformers.js serait bloqué par la CSP.
env.allowLocalModels = false;
env.useBrowserCache = true;
env.useWasmCache = false;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: chrome.runtime.getURL("ort/ort-wasm-simd-threaded.asyncify.mjs"),
    wasm: chrome.runtime.getURL("ort/ort-wasm-simd-threaded.asyncify.wasm"),
  };
}

type NerPipeline = (text: string, options: { aggregation_strategy: "simple" }) => Promise<NerGroup[]>;
type LlmPipeline = (
  messages: ChatMessage[],
  options: { max_new_tokens: number; do_sample: boolean }
) => Promise<{ generated_text: ChatMessage[] }[]>;

const states: Record<ModelKind, ModelState> = { ner: { state: "idle" }, llm: { state: "idle" } };
const loaders: Partial<Record<ModelKind, Promise<unknown>>> = {};
let webgpu: boolean | null = null;

async function hasWebGpu(): Promise<boolean> {
  if (webgpu !== null) return webgpu;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    webgpu = Boolean(gpu && (await gpu.requestAdapter()));
  } catch {
    webgpu = false;
  }
  return webgpu;
}

export function getStatus(): AiStatus {
  return { webgpu, ner: states.ner, llm: states.llm };
}

function load(kind: ModelKind): Promise<unknown> {
  const existing = loaders[kind];
  if (existing) return existing;

  const config = MODELS[kind];
  states[kind] = { state: "loading", progress: null };

  const promise = (async () => {
    // Le NER est assez rapide sur CPU ; le LLM profite du GPU quand il est là.
    const device = kind === "llm" && (await hasWebGpu()) ? "webgpu" : "wasm";
    const task = kind === "ner" ? "token-classification" : "text-generation";
    const model = await pipeline(task, config.id, {
      device,
      dtype: config.dtype[device] as "q8",
      progress_callback: (info: ProgressInfo) => {
        if (info.status === "progress_total") {
          states[kind] = { state: "loading", progress: Math.round(info.progress) };
        }
      },
    });
    states[kind] = { state: "ready", device };
    return model;
  })();

  loaders[kind] = promise;
  promise.catch((error: unknown) => {
    states[kind] = { state: "error", error: error instanceof Error ? error.message : String(error) };
    delete loaders[kind];
  });

  return promise;
}

export function startLoading(kinds: { ner: boolean; llm: boolean }): void {
  void hasWebGpu();
  // Chargement séquentiel : deux téléchargements parallèles saturent la mémoire.
  void (async () => {
    if (kinds.ner) await load("ner").catch(() => {});
    if (kinds.llm) await load("llm").catch(() => {});
  })();
}

async function runNer(text: string): Promise<SensitiveEntity[]> {
  const ner = (await load("ner")) as NerPipeline;
  const entities: SensitiveEntity[] = [];
  for (const chunk of splitForNer(text)) {
    const groups = await ner(chunk.text, { aggregation_strategy: "simple" });
    entities.push(...locateNerGroups(chunk, groups));
  }
  return entities;
}

async function runLlm(text: string): Promise<ContextVerdict> {
  const llm = (await load("llm")) as LlmPipeline;
  const messages = buildMessages(text);
  const output = await llm(messages, { max_new_tokens: 160, do_sample: false });
  const reply = output[0].generated_text.at(-1)?.content ?? "";
  return parseVerdict(reply, text);
}

export async function analyze(text: string, kinds: { ner: boolean; llm: boolean }): Promise<AiFindings> {
  const findings: AiFindings = { ner: null, verdict: null, timings: {} };

  if (kinds.ner) {
    const start = performance.now();
    findings.ner = await runNer(text);
    findings.timings.nerMs = Math.round(performance.now() - start);
  }

  if (kinds.llm) {
    const start = performance.now();
    findings.verdict = await runLlm(text);
    findings.timings.llmMs = Math.round(performance.now() - start);
  }

  return findings;
}
