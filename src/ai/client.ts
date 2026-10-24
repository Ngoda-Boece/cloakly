import type { AnalyzeResponse, AiRequest, AiStatus, Envelope } from "./protocol";
import { IDLE_STATUS } from "./protocol";
import type { AiFindings } from "../engine/analysis";

async function send<T>(request: AiRequest): Promise<T> {
  const envelope: Envelope = { ...request, target: "background" };
  try {
    return (await chrome.runtime.sendMessage(envelope)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Typiquement : extension pas rechargée après un build, service worker absent ou planté.
    throw new Error(
      message.includes("Receiving end does not exist")
        ? "le service worker de Cloakly ne répond pas. Rechargez l'extension (↻ dans chrome://extensions)."
        : message
    );
  }
}

/** Le service worker répond { ok: false, error } en cas d'échec, à la place d'un état. */
function asStatus(response: unknown): AiStatus {
  if (response && typeof response === "object" && "ner" in response && "llm" in response) {
    return response as AiStatus;
  }
  const error = (response as { error?: string } | undefined)?.error;
  throw new Error(error ?? "réponse inattendue du moteur IA.");
}

export function isExtensionContext(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
}

export async function getAiStatus(): Promise<AiStatus> {
  if (!isExtensionContext()) return IDLE_STATUS;
  return asStatus(await send<unknown>({ type: "status" }));
}

export async function loadModels(kinds: { ner: boolean; llm: boolean }): Promise<AiStatus> {
  if (!isExtensionContext()) return IDLE_STATUS;
  return asStatus(await send<unknown>({ type: "load", ...kinds }));
}

export class AiTimeoutError extends Error {}

export async function analyzeWithAi(
  text: string,
  kinds: { ner: boolean; llm: boolean },
  timeoutMs: number
): Promise<AiFindings> {
  if (!isExtensionContext()) throw new Error("Moteur IA disponible uniquement dans l'extension.");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiTimeoutError("L'analyse IA a dépassé le délai autorisé.")), timeoutMs);
  });

  try {
    const response = await Promise.race([send<AnalyzeResponse>({ type: "analyze", text, ...kinds }), timeout]);
    if (!response) throw new Error("Le moteur IA n'a pas répondu.");
    if (!response.ok) throw new Error(response.error);
    return response.findings;
  } finally {
    clearTimeout(timer);
  }
}
