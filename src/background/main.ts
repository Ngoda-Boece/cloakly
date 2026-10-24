import { IDLE_STATUS, type AiRequest, type Envelope } from "../ai/protocol";

const OFFSCREEN_URL = "offscreen.html";
let creating: Promise<void> | null = null;

async function offscreenExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await offscreenExists()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS" as chrome.offscreen.Reason],
      justification: "Exécuter localement les modèles IA qui détectent les données confidentielles.",
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/**
 * Juste après sa création, le document offscreen peut ne pas encore écouter
 * (transformers.js est long à évaluer) : on réessaie pendant quelques secondes.
 */
async function sendToOffscreen(envelope: Envelope): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage(envelope);
      if (response !== undefined) return response;
      throw new Error("Receiving end does not exist (réponse vide)");
    } catch (error) {
      const notReady = String(error).includes("Receiving end does not exist");
      if (!notReady || attempt >= 50) {
        throw new Error(`Le moteur IA ne répond pas (${error instanceof Error ? error.message : String(error)})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function forward(request: AiRequest): Promise<unknown> {
  // Ne pas créer le document (ni charger de modèle) pour une simple question d'état.
  if (request.type === "status" && !(await offscreenExists())) return IDLE_STATUS;
  if (!chrome.offscreen) {
    throw new Error("API offscreen indisponible : Chrome 116 ou plus récent est nécessaire.");
  }
  await ensureOffscreen();
  return sendToOffscreen({ ...request, target: "offscreen" });
}

chrome.runtime.onMessage.addListener((message: Envelope, _sender, sendResponse) => {
  if (message?.target !== "background") return false;
  forward(message)
    .then(sendResponse)
    .catch((error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
  return true;
});

// Les alias de pseudonymisation sont gardés dans storage.session (effacé à la
// fermeture du navigateur) : il faut l'ouvrir aux content scripts.
chrome.storage.session
  .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
  .catch((error: unknown) => console.warn("[Cloakly] storage.session inaccessible aux pages :", error));
