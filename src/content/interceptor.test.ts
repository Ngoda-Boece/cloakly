// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiFindings } from "../engine/analysis";
import { createAliasRegistry } from "../engine/anonymize";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import type { SupportedSite } from "../shared/sites";
import { existingRoot, HOST_ID } from "./dialog";
import { readEditorText } from "./editor";
import { installInterceptor, type AiAnalyzer, type InterceptorOptions } from "./interceptor";

const site: SupportedSite = {
  id: "test",
  name: "Test",
  hosts: ["test.local"],
  editorSelectors: ["#editor"],
  sendButtonSelectors: ["#send"],
};

let settings: Settings;
let sent: string[];
let dispose: () => void;

function setup(
  editorHtml = `<div id="editor" contenteditable="true"></div>`,
  analyzeAi?: AiAnalyzer,
  extra: Partial<InterceptorOptions> = {}
) {
  document.body.innerHTML = `<form>${editorHtml}<button id="send" type="button">Envoyer</button></form>`;
  const editor = document.getElementById("editor") as HTMLElement;

  // Simule le site : le bouton et la touche Entrée envoient le contenu de l'éditeur.
  document.getElementById("send")!.addEventListener("click", () => sent.push(readEditorText(editor)));
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.defaultPrevented) sent.push(readEditorText(editor));
  });

  dispose = installInterceptor({
    doc: document,
    site,
    getSettings: () => settings,
    sendTimeoutMs: 50,
    aiTimeoutMs: 500,
    analyzeAi,
    ...extra,
  });
  return editor;
}

function type(editor: HTMLElement, text: string) {
  if (editor instanceof HTMLTextAreaElement) editor.value = text;
  else editor.textContent = text;
}

function clickSend() {
  document.getElementById("send")!.click();
}

// Racine fermée : invisible pour le site, on passe par la référence du content script.
function shadow() {
  return existingRoot(document);
}

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitFor<T>(read: () => T | null | undefined, timeout = 1000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Délai dépassé");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function dialogButton(label: string) {
  return [...(shadow()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === label) ?? null;
}

function checkbox(value: string) {
  return (
    [...(shadow()?.querySelectorAll<HTMLInputElement>("ul.items input") ?? [])].find((input) =>
      input.closest("label")?.textContent?.includes(value)
    ) ?? null
  );
}

async function confirm() {
  (await waitFor(() => dialogButton("Remplacer et envoyer"))).click();
  await waitFor(() => sent.length > 0);
}

beforeEach(() => {
  settings = structuredClone(DEFAULT_SETTINGS);
  sent = [];
});

afterEach(() => {
  dispose?.();
  document.getElementById(HOST_ID)?.remove();
  document.body.innerHTML = "";
});

describe("intercepteur — règles", () => {
  it("laisse passer un message sans donnée sensible", () => {
    const editor = setup();
    type(editor, "Résume ce texte s'il te plaît");
    clickSend();
    expect(sent).toEqual(["Résume ce texte s'il te plaît"]);
    expect(shadow()?.querySelector(".dialog") ?? null).toBeNull();
  });

  it("bloque l'envoi, affiche l'aperçu puis envoie la version protégée après confirmation", async () => {
    const editor = setup();
    type(editor, "Écris à paul@acme.fr au sujet du serveur 203.0.113.12");
    clickSend();

    expect(sent).toEqual([]);
    const preview = await waitFor(() => shadow()?.querySelector("pre"));
    expect(preview.textContent).toBe("Écris à [EMAIL_1] au sujet du serveur [ADRESSE_IP_1]");
    expect(shadow()!.querySelector("[role='dialog']")?.getAttribute("aria-modal")).toBe("true");

    await confirm();
    expect(sent).toEqual(["Écris à [EMAIL_1] au sujet du serveur [ADRESSE_IP_1]"]);
    expect(shadow()!.querySelector(".toast")?.textContent).toContain("Message protégé : 2 données");
  });

  it("intercepte la touche Entrée dans l'éditeur", async () => {
    const editor = setup();
    type(editor, "Ma clé : sk-proj-abcdefghijklmnopqrstuvwxyz0123");
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(sent).toEqual([]);
    await confirm();
    expect(sent).toEqual(["Ma clé : [SECRET_1]"]);
  });

  it("n'envoie rien et conserve le texte si l'utilisateur annule (Échap)", async () => {
    const editor = setup();
    type(editor, "Mon IBAN FR7630006000011234567890189");
    clickSend();

    const dialog = await waitFor(() => shadow()?.querySelector(".dialog"));
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();

    expect(sent).toEqual([]);
    expect(shadow()!.querySelector(".dialog")).toBeNull();
    expect(readEditorText(editor)).toBe("Mon IBAN FR7630006000011234567890189");
  });

  it("en mode strict : pas d'envoi non protégé et détections des règles verrouillées", async () => {
    const editor = setup();
    type(editor, "a@b.fr");
    clickSend();
    await waitFor(() => shadow()?.querySelector(".dialog"));
    expect(dialogButton("Envoyer sans protéger")).toBeNull();
    expect(checkbox("a@b.fr")?.disabled).toBe(true);
  });

  it("hors mode strict : on peut décocher une donnée, l'aperçu suit et elle est conservée", async () => {
    settings.strictMode = false;
    const editor = setup();
    type(editor, "a@b.fr et 06 12 34 56 78");
    clickSend();

    const box = await waitFor(() => checkbox("a@b.fr"));
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(shadow()!.querySelector("pre")?.textContent).toBe("a@b.fr et [TELEPHONE_1]");

    await confirm();
    expect(sent).toEqual(["a@b.fr et [TELEPHONE_1]"]);
  });

  it("permet l'envoi de l'original hors mode strict, avec avertissement", async () => {
    settings.strictMode = false;
    const editor = setup();
    type(editor, "a@b.fr");
    clickSend();

    (await waitFor(() => dialogButton("Envoyer sans protéger"))).click();
    await waitFor(() => sent.length > 0);
    expect(sent).toEqual(["a@b.fr"]);
    expect(shadow()!.querySelector(".toast.warning")?.textContent).toContain("sans protection");
  });

  it("ne fait rien quand la protection est désactivée", () => {
    settings.enabled = false;
    const editor = setup();
    type(editor, "a@b.fr");
    clickSend();
    expect(sent).toEqual(["a@b.fr"]);
  });

  it("respecte les catégories et termes personnalisés", async () => {
    settings = { ...settings, categories: ["confidential"], customTerms: ["Projet Atlas"] };
    const editor = setup();
    type(editor, "a@b.fr parle du projet atlas");
    clickSend();
    await confirm();
    expect(sent).toEqual(["a@b.fr parle du [TERME_CONFIDENTIEL_1]"]);
  });

  it("pseudonymise de façon cohérente d'un message à l'autre", async () => {
    const editor = setup();
    for (const text of ["Contact : a@b.fr", "Nouveau c@d.fr et ancien a@b.fr"]) {
      type(editor, text);
      clickSend();
      (await waitFor(() => dialogButton("Remplacer et envoyer"))).click();
      await waitFor(() => sent.length > 0 && !shadow()?.querySelector(".dialog"));
      await flush();
    }
    expect(sent).toEqual(["Contact : [EMAIL_1]", "Nouveau [EMAIL_2] et ancien [EMAIL_1]"]);
  });

  it("fonctionne avec un textarea", async () => {
    const editor = setup(`<textarea id="editor"></textarea>`);
    type(editor, "Appelle le 06 12 34 56 78");
    clickSend();
    await confirm();
    expect(sent).toEqual(["Appelle le [TELEPHONE_1]"]);
  });

  it("bloque l'envoi en mode strict si le remplacement ne peut pas être vérifié", async () => {
    const editor = setup(`<textarea id="editor"></textarea>`);
    // Éditeur récalcitrant : il ignore toute modification programmatique.
    Object.defineProperty(editor, "value", { get: () => "Mail : a@b.fr", set: () => {} });
    clickSend();

    (await waitFor(() => dialogButton("Remplacer et envoyer"))).click();
    const alert = await waitFor(() => shadow()?.querySelector("[role='alertdialog']"));

    expect(alert.textContent).toContain("Envoi bloqué");
    expect(alert.textContent).toContain("Rien n'a été envoyé");
    expect(dialogButton("Envoyer sans protection")).toBeNull();
    expect(sent).toEqual([]);
    expect(shadow()!.querySelector(".toast.success")).toBeNull();
  });

  it("propose l'envoi non protégé hors mode strict si le remplacement échoue", async () => {
    settings.strictMode = false;
    const editor = setup(`<textarea id="editor"></textarea>`);
    Object.defineProperty(editor, "value", { get: () => "Mail : a@b.fr", set: () => {} });
    clickSend();

    (await waitFor(() => dialogButton("Remplacer et envoyer"))).click();
    const alert = await waitFor(() => shadow()?.querySelector("[role='alertdialog']"));
    expect(alert.textContent).toContain("Protection impossible");
    expect(alert.textContent).toContain("n'est pas protégé");
    expect(sent).toEqual([]);
  });

  it("bloque en mode strict quand l'éditeur est introuvable", async () => {
    setup();
    document.getElementById("editor")!.remove();
    clickSend();

    const alert = await waitFor(() => shadow()?.querySelector("[role='alertdialog']"));
    expect(alert.textContent).toContain("Zone de saisie introuvable");
    expect(sent).toEqual([]);
  });

  it("garde le focus dans la boîte de dialogue (Tab)", async () => {
    const editor = setup();
    type(editor, "a@b.fr");
    clickSend();

    const dialog = await waitFor(() => shadow()?.querySelector(".dialog"));
    expect(shadow()!.activeElement?.textContent).toBe("Remplacer et envoyer");
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(shadow()!.activeElement?.textContent).toBe("Annuler");
  });
});

describe("intercepteur — apprentissage", () => {
  it("signale les données décochées après un envoi protégé", async () => {
    const onCorrections = vi.fn();
    const editor = setup(undefined, undefined, { onCorrections });
    type(editor, "Appelle Jeanne Martin au 06 12 34 56 78 demain.");
    clickSend();

    const box = await waitFor(() => checkbox("Jeanne Martin"));
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await confirm();

    expect(sent).toEqual(["Appelle Jeanne Martin au [TELEPHONE_1] demain."]);
    expect(onCorrections).toHaveBeenCalledWith([{ kind: "unmasked", type: "PERSON", value: "Jeanne Martin" }]);
  });

  it("ne signale rien quand la revue est acceptée telle quelle", async () => {
    const onCorrections = vi.fn();
    const editor = setup(undefined, undefined, { onCorrections });
    type(editor, "Appelle Jeanne Martin au 06 12 34 56 78 demain.");
    clickSend();
    await confirm();
    expect(onCorrections).not.toHaveBeenCalled();
  });

  it("propose décochée une valeur apprise, avec son motif, et l'envoie telle quelle", async () => {
    settings.allowTerms = ["Jeanne Martin"];
    const editor = setup();
    type(editor, "Appelle Jeanne Martin au 06 12 34 56 78 demain.");
    clickSend();

    const box = await waitFor(() => checkbox("Jeanne Martin"));
    expect(box.checked).toBe(false);
    expect(box.closest("label")?.textContent).toContain("appris de vos corrections");
    await confirm();
    expect(sent).toEqual(["Appelle Jeanne Martin au [TELEPHONE_1] demain."]);
  });
});

describe("intercepteur — IA locale", () => {
  const complex =
    "Bonjour Marc, nous confirmons le rachat de Biocoop prévu le 15 mars, merci de ne pas en parler.";

  function aiFindings(text: string): AiFindings {
    const excerpt = "le rachat de Biocoop prévu le 15 mars";
    return {
      ner: [
        { type: "PERSON", value: "Marc", start: text.indexOf("Marc"), end: text.indexOf("Marc") + 4, source: "ner", score: 0.99 },
        { type: "ORGANIZATION", value: "Biocoop", start: text.indexOf("Biocoop"), end: text.indexOf("Biocoop") + 7, source: "ner", score: 1 },
      ],
      verdict: {
        risk: "high",
        reason: "Rachat non annoncé.",
        excerpts: [{ value: excerpt, start: text.indexOf(excerpt), end: text.indexOf(excerpt) + excerpt.length }],
      },
      timings: { nerMs: 30, llmMs: 900 },
    };
  }

  beforeEach(() => {
    settings.ai = { ner: true, llm: true, locations: false };
  });

  it("analyse le message avec l'IA, montre le verdict et pseudonymise les entités", async () => {
    const analyze = vi.fn<AiAnalyzer>(async (text) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return aiFindings(text);
    });
    const editor = setup(undefined, analyze);
    type(editor, complex);
    clickSend();

    expect(sent).toEqual([]);
    // Pendant l'analyse, un bandeau indique que l'IA locale travaille.
    expect(shadow()!.querySelector(".toast.progress")?.textContent).toContain("IA locale (NER + LLM) : analyse en cours");
    await waitFor(() => shadow()?.querySelector(".verdict"));
    expect(analyze).toHaveBeenCalledWith(complex, { ner: true, llm: true }, 500);
    expect(shadow()!.querySelector(".verdict")?.textContent).toContain("risque élevé");
    expect(shadow()!.querySelector(".engines")?.textContent).toMatch(/Analyse locale : règles \+ NER \+ LLM, \d+,\d s/);

    await confirm();
    expect(sent).toEqual([
      "Bonjour [PERSONNE_1], nous confirmons le rachat de [ORGANISATION_1] [INFORMATION_SENSIBLE_1], merci de ne pas en parler.",
    ]);
  });

  it("les détections IA restent décochables en mode strict", async () => {
    const editor = setup(undefined, async (text) => aiFindings(text));
    type(editor, complex);
    clickSend();

    const box = await waitFor(() => checkbox("Marc"));
    expect(box.disabled).toBe(false);
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await confirm();
    expect(sent[0]).toMatch(/^Bonjour Marc, /);
  });

  it("envoie directement un message que l'IA juge sans risque", async () => {
    const editor = setup(undefined, async () => ({ ner: [], verdict: { risk: "none", reason: "", excerpts: [] }, timings: {} }));
    type(editor, "Peux-tu m'expliquer la différence entre TCP et UDP en détail ?");
    clickSend();
    expect(sent).toEqual([]);
    await waitFor(() => sent.length > 0);
    expect(sent).toEqual(["Peux-tu m'expliquer la différence entre TCP et UDP en détail ?"]);
    // L'utilisateur voit que l'IA locale a bien analysé le message.
    expect(shadow()!.querySelector(".toast.success")?.textContent).toContain("Analysé localement (règles + NER + LLM");
  });

  it("n'interrompt pas pour un verdict sans extrait vérifiable", async () => {
    const editor = setup(undefined, async () => ({ ner: [], verdict: { risk: "high", reason: "?", excerpts: [] }, timings: {} }));
    type(editor, "Comment Napoléon a-t-il perdu à Waterloo, selon les historiens ?");
    clickSend();
    await waitFor(() => sent.length > 0);
    expect(shadow()?.querySelector(".dialog") ?? null).toBeNull();
  });

  it("n'appelle pas le LLM pour un message court", async () => {
    const analyze = vi.fn<AiAnalyzer>(async () => ({ ner: [], verdict: null, timings: {} }));
    const editor = setup(undefined, analyze);
    type(editor, "Salut !");
    clickSend();
    await waitFor(() => sent.length > 0);
    expect(analyze).toHaveBeenCalledWith("Salut !", { ner: true, llm: false }, 500);
  });

  it("si l'IA échoue en mode strict : rien n'est envoyé, on peut continuer avec les règles", async () => {
    const editor = setup(undefined, async () => {
      throw new Error("modèle introuvable");
    });
    type(editor, "Écris à paul@acme.fr pour confirmer le rendez-vous de demain matin.");
    clickSend();

    const alert = await waitFor(() => shadow()?.querySelector("[role='alertdialog']"));
    expect(alert.textContent).toContain("modèle introuvable");
    expect(dialogButton("Envoyer sans protection")).toBeNull();
    expect(sent).toEqual([]);

    dialogButton("Analyser sans l'IA")!.click();
    await confirm();
    expect(sent).toEqual(["Écris à [EMAIL_1] pour confirmer le rendez-vous de demain matin."]);
  });

  it("traite un dépassement de délai comme un échec de l'IA", async () => {
    const editor = setup(undefined, (_text, _kinds, timeout) => new Promise((_, reject) => setTimeout(() => reject(new Error(`délai de ${timeout} ms dépassé`)), 20)));
    type(editor, "Un message assez long pour déclencher l'analyse de contexte complète.");
    clickSend();
    const alert = await waitFor(() => shadow()?.querySelector("[role='alertdialog']"));
    expect(alert.textContent).toContain("délai de 500 ms dépassé");
  });

  it("garde les alias entre messages et les signale pour la persistance", async () => {
    const aliases = createAliasRegistry();
    const onAliasesChanged = vi.fn();
    document.body.innerHTML = `<form><div id="editor" contenteditable="true"></div><button id="send" type="button">Envoyer</button></form>`;
    const editor = document.getElementById("editor")!;
    document.getElementById("send")!.addEventListener("click", () => sent.push(readEditorText(editor)));
    dispose = installInterceptor({
      doc: document,
      site,
      getSettings: () => settings,
      aliases,
      onAliasesChanged,
      sendTimeoutMs: 50,
      analyzeAi: async (text) => aiFindings(text),
    });

    type(editor, complex);
    clickSend();
    await confirm();
    expect(onAliasesChanged).toHaveBeenCalledWith(aliases);
    expect([...aliases.values()].map((entry) => entry.original)).toContain("Marc");
  });
});
