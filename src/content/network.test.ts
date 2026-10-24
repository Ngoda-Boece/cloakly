// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiFindings } from "../engine/analysis";
import { createAliasRegistry } from "../engine/anonymize";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import type { SupportedSite } from "../shared/sites";
import { existingRoot, HOST_ID } from "./dialog";
import { readEditorText } from "./editor";
import { installInterceptor, type AiAnalyzer } from "./interceptor";

/**
 * Comportement réseau : une page de fournisseur simulée envoie le contenu de
 * l'éditeur par `fetch` (clic, Entrée, soumission de formulaire). On vérifie
 * directement les corps de requête : aucune donnée d'origine ne doit y figurer.
 * Données synthétiques.
 */

const site: SupportedSite = {
  id: "fake-provider",
  name: "Fournisseur simulé",
  hosts: ["provider.test"],
  editorSelectors: ["#editor"],
  sendButtonSelectors: ["#send"],
};

const ORIGINALS = {
  email: "jeanne.martin@exemple.fr",
  phone: "06 12 34 56 78",
  name: "Jeanne Martin",
  iban: "FR76 3000 6000 0112 3456 7890 189",
  key: "sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34",
};
const PROMPT = `Je m'appelle ${ORIGINALS.name}, mon mail ${ORIGINALS.email}, tél. ${ORIGINALS.phone}, IBAN ${ORIGINALS.iban}, clé ${ORIGINALS.key}. Calcule 15 % de 1 200 €.`;

let settings: Settings;
let requests: string[];
let dispose: () => void;
let fetchMock: ReturnType<typeof vi.fn>;

function setup(options: { mode?: "button" | "form"; analyzeAi?: AiAnalyzer; aliases?: ReturnType<typeof createAliasRegistry> } = {}) {
  const mode = options.mode ?? "button";
  document.body.innerHTML =
    mode === "form"
      ? `<form id="composer"><div id="editor" contenteditable="true"></div><button id="send" type="submit">Envoyer</button></form>`
      : `<div><div id="editor" contenteditable="true"></div><button id="send" type="button">Envoyer</button></div>`;
  const editor = document.getElementById("editor") as HTMLElement;

  // Le « fournisseur » : ses propres gestionnaires lisent l'éditeur et l'envoient sur le réseau.
  const send = () =>
    void window.fetch("https://provider.test/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: readEditorText(editor) }] }),
    });
  if (mode === "form") {
    document.getElementById("composer")!.addEventListener("submit", (event) => {
      event.preventDefault();
      send();
    });
  } else {
    document.getElementById("send")!.addEventListener("click", send);
  }
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.defaultPrevented) send();
  });

  dispose = installInterceptor({
    doc: document,
    site,
    getSettings: () => settings,
    sendTimeoutMs: 50,
    aiTimeoutMs: 300,
    analyzeAi: options.analyzeAi,
    aliases: options.aliases,
  });
  editor.textContent = PROMPT;
  return editor;
}

const root = () => existingRoot(document);

async function waitFor<T>(read: () => T | null | undefined, timeout = 2000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Délai dépassé");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const button = (label: string) =>
  [...(root()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === label) ?? null;

async function settle() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

function expectNoOriginal(bodies: readonly string[]) {
  for (const body of bodies) {
    for (const value of Object.values(ORIGINALS)) expect(body).not.toContain(value);
    // Aucun fragment identifiant (nom de famille, partie locale de l'e-mail) non plus.
    expect(body).not.toContain("Martin");
    expect(body).not.toContain("jeanne.martin");
  }
}

beforeEach(() => {
  settings = structuredClone(DEFAULT_SETTINGS);
  requests = [];
  fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    requests.push(String(init?.body ?? ""));
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  dispose?.();
  document.getElementById(HOST_ID)?.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("réseau — seul le texte transformé part", () => {
  it.each(["click", "enter"] as const)("envoi par %s : la requête ne contient que des marqueurs", async (trigger) => {
    const editor = setup();
    if (trigger === "click") document.getElementById("send")!.click();
    else editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    // Rien ne part avant la confirmation.
    await settle();
    expect(requests).toEqual([]);

    (await waitFor(() => button("Remplacer et envoyer"))).click();
    await waitFor(() => requests.length > 0);

    expect(requests).toHaveLength(1);
    expectNoOriginal(requests);
    const content = JSON.parse(requests[0]).messages[0].content as string;
    expect(content).toBe(
      "Je m'appelle [PERSONNE_1], mon mail [EMAIL_1], tél. [TELEPHONE_1], IBAN [IBAN_1], clé [SECRET_1]. Calcule 15 % de 1 200 €."
    );
  });

  it("soumission de formulaire : même garantie", async () => {
    setup({ mode: "form" });
    document.getElementById("send")!.click();
    await settle();
    expect(requests).toEqual([]);
    (await waitFor(() => button("Remplacer et envoyer"))).click();
    await waitFor(() => requests.length > 0);
    expectNoOriginal(requests);
  });

  it("annulation : aucune requête", async () => {
    setup();
    document.getElementById("send")!.click();
    (await waitFor(() => button("Annuler"))).click();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("double envoi pendant l'analyse : le second est bloqué", async () => {
    const editor = setup();
    document.getElementById("send")!.click();
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    document.getElementById("send")!.click();
    await settle();
    expect(requests).toEqual([]);
    (await waitFor(() => button("Remplacer et envoyer"))).click();
    await waitFor(() => requests.length > 0);
    await settle();
    expect(requests).toHaveLength(1);
    expectNoOriginal(requests);
  });

  it("éditeur qui refuse la réécriture (mode strict) : aucune requête", async () => {
    setup();
    const editor = document.getElementById("editor")!;
    // Simule un éditeur qui rétablit son contenu après chaque modification programmatique.
    new MutationObserver(() => {
      if (editor.textContent !== PROMPT) editor.textContent = PROMPT;
    }).observe(editor, { childList: true, characterData: true, subtree: true });

    document.getElementById("send")!.click();
    (await waitFor(() => button("Remplacer et envoyer"))).click();
    await waitFor(() => root()?.querySelector("[role='alertdialog']"));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("IA locale en échec puis repli sur les règles : aucune donnée d'origine", async () => {
    setup({
      analyzeAi: async () => {
        throw new Error("modèle indisponible");
      },
    });
    settings.ai = { ner: true, llm: true, locations: false };
    document.getElementById("send")!.click();
    (await waitFor(() => button("Analyser sans l'IA"))).click();
    (await waitFor(() => button("Remplacer et envoyer"))).click();
    await waitFor(() => requests.length > 0);
    expectNoOriginal(requests);
  });

  it("IA locale qui ne trouve rien : les règles masquent quand même", async () => {
    const empty: AiFindings = { ner: [], verdict: { risk: "none", reason: "", excerpts: [] }, timings: {} };
    setup({ analyzeAi: async () => empty });
    settings.ai = { ner: true, llm: true, locations: false };
    document.getElementById("send")!.click();
    (await waitFor(() => button("Remplacer et envoyer"))).click();
    await waitFor(() => requests.length > 0);
    expectNoOriginal(requests);
  });

  it("hors mode strict, un secret reste non décochable", async () => {
    settings.strictMode = false;
    setup();
    document.getElementById("send")!.click();
    const boxes = await waitFor(() => {
      const inputs = [...(root()?.querySelectorAll<HTMLInputElement>("ul.items input") ?? [])];
      return inputs.length ? inputs : null;
    });
    const secretBox = boxes.find((input) => input.closest("label")?.textContent?.includes(ORIGINALS.key));
    expect(secretBox?.disabled).toBe(true);
  });

  it("message suivant : une valeur déjà masquée l'est encore, sans IA", async () => {
    const aliases = createAliasRegistry();
    setup({ aliases });
    document.getElementById("send")!.click();
    (await waitFor(() => button("Remplacer et envoyer"))).click();
    await waitFor(() => requests.length > 0);
    await settle();

    const editor = document.getElementById("editor")!;
    // « Martin » seul n'a aucun indice : seule la mémoire de session permet de le masquer.
    editor.textContent = "Rappelle à Martin de répondre.";
    document.getElementById("send")!.click();
    (await waitFor(() => button("Remplacer et envoyer"))).click();
    await waitFor(() => requests.length > 1);
    expect(JSON.parse(requests[1]).messages[0].content).toBe("Rappelle à [PERSONNE_1] de répondre.");
  });
});

describe("autres chemins de fuite", () => {
  it("la page ne peut pas lire la revue ni la table de correspondance (racine fermée)", async () => {
    setup();
    document.getElementById("send")!.click();
    await waitFor(() => root()?.querySelector(".dialog"));

    const host = document.getElementById(HOST_ID)!;
    expect(host.shadowRoot).toBeNull();
    // En dehors de l'éditeur (où l'utilisateur a tapé), aucune valeur n'est visible pour la page.
    const editor = document.getElementById("editor")!;
    const visible = document.documentElement.textContent!.replace(editor.textContent!, "");
    for (const value of Object.values(ORIGINALS)) expect(visible).not.toContain(value);
  });

  it("aucune valeur d'origine dans la console", async () => {
    const calls: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void calls.push(args))
    );
    setup();
    document.getElementById("send")!.click();
    (await waitFor(() => button("Remplacer et envoyer"))).click();
    await waitFor(() => requests.length > 0);
    const logged = JSON.stringify(calls);
    for (const value of Object.values(ORIGINALS)) expect(logged).not.toContain(value);
    for (const spy of spies) spy.mockRestore();
  });

  it("une erreur de validation n'affiche aucune valeur d'origine", async () => {
    setup();
    const editor = document.getElementById("editor")!;
    new MutationObserver(() => {
      if (editor.textContent !== PROMPT) editor.textContent = PROMPT;
    }).observe(editor, { childList: true, characterData: true, subtree: true });
    document.getElementById("send")!.click();
    (await waitFor(() => button("Remplacer et envoyer"))).click();
    const alert = await waitFor(() => root()?.querySelector("[role='alertdialog']"));
    for (const value of Object.values(ORIGINALS)) expect(alert.textContent).not.toContain(value);
  });
});
