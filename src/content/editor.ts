import { normalizeForComparison } from "../engine/protect";

type TextField = HTMLTextAreaElement | HTMLInputElement;

function isTextField(element: Element): element is TextField {
  const tag = element.tagName;
  return tag === "TEXTAREA" || tag === "INPUT";
}

export function readEditorText(editor: HTMLElement): string {
  if (isTextField(editor)) return editor.value;

  // innerText respecte les sauts de ligne des paragraphes ; jsdom ne l'implémente pas.
  const inner = (editor as { innerText?: unknown }).innerText;
  return typeof inner === "string" ? inner : (editor.textContent ?? "");
}

function matches(editor: HTMLElement, expected: string): boolean {
  return normalizeForComparison(readEditorText(editor)) === normalizeForComparison(expected);
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function selectAllContent(editor: HTMLElement) {
  editor.focus();
  const selection = editor.ownerDocument.getSelection();
  if (!selection) return;
  const range = editor.ownerDocument.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Simule un collage : ProseMirror (ChatGPT, Claude) et Quill (Gemini) le gèrent nativement. */
function pasteText(editor: HTMLElement, text: string): void {
  if (typeof DataTransfer === "undefined" || typeof ClipboardEvent === "undefined") return;
  const data = new DataTransfer();
  data.setData("text/plain", text);
  editor.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
  );
}

function insertText(editor: HTMLElement, text: string): void {
  try {
    editor.ownerDocument.execCommand?.("insertText", false, text);
  } catch {
    // execCommand peut être absent ou refusé : on passe à la stratégie suivante.
  }
}

function replaceDom(editor: HTMLElement, text: string): void {
  const doc = editor.ownerDocument;
  editor.replaceChildren(
    ...text.split("\n").map((line) => {
      const paragraph = doc.createElement("p");
      if (line) paragraph.textContent = line;
      else paragraph.appendChild(doc.createElement("br"));
      return paragraph;
    })
  );
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
}

/**
 * Remplace tout le contenu de l'éditeur. Retourne true seulement si le texte
 * relu correspond au texte demandé.
 */
export async function writeEditorText(editor: HTMLElement, text: string): Promise<boolean> {
  if (isTextField(editor)) {
    // Passer par le setter natif pour que React détecte le changement.
    const prototype = Object.getPrototypeOf(editor) as TextField;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(editor, text);
    else editor.value = text;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    return matches(editor, text);
  }

  const strategies = [pasteText, insertText, replaceDom];
  for (const strategy of strategies) {
    selectAllContent(editor);
    strategy(editor, text);
    await nextTick();
    if (matches(editor, text)) return true;
  }

  return false;
}
