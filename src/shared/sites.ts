export type SupportedSite = {
  id: string;
  name: string;
  hosts: string[];
  /** Zone de saisie du message, du sélecteur le plus spécifique au plus générique. */
  editorSelectors: string[];
  /** Bouton d'envoi du message. */
  sendButtonSelectors: string[];
};

export const SUPPORTED_SITES: SupportedSite[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    hosts: ["chatgpt.com", "chat.openai.com"],
    editorSelectors: ["#prompt-textarea", "form [contenteditable='true']", "form textarea"],
    sendButtonSelectors: [
      "button[data-testid='send-button']",
      "#composer-submit-button",
    ],
  },
  {
    id: "claude",
    name: "Claude",
    hosts: ["claude.ai"],
    editorSelectors: [
      "div.ProseMirror[contenteditable='true']",
      "fieldset [contenteditable='true']",
    ],
    sendButtonSelectors: [
      "button[aria-label='Send message']",
      "button[aria-label='Envoyer le message']",
      "fieldset button[type='submit']",
    ],
  },
  {
    id: "gemini",
    name: "Gemini",
    hosts: ["gemini.google.com"],
    editorSelectors: ["rich-textarea .ql-editor[contenteditable='true']", ".ql-editor[contenteditable='true']"],
    sendButtonSelectors: [
      "button.send-button",
      "button[aria-label='Send message']",
      "button[aria-label='Envoyer le message']",
    ],
  },
  {
    id: "mistral",
    name: "Le Chat (Mistral)",
    hosts: ["chat.mistral.ai"],
    editorSelectors: ["form [contenteditable='true']", "form textarea", "textarea"],
    sendButtonSelectors: ["form button[type='submit']", "button[aria-label='Send question']"],
  },
];

export function findSiteForHost(hostname: string): SupportedSite | null {
  const host = hostname.toLowerCase();
  return SUPPORTED_SITES.find((site) => site.hosts.includes(host)) ?? null;
}

export function findSiteForUrl(url: string | undefined): SupportedSite | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? findSiteForHost(parsed.hostname) : null;
  } catch {
    return null;
  }
}

/** Motifs `content_scripts.matches` attendus dans le manifest. */
export function manifestMatches(): string[] {
  return SUPPORTED_SITES.flatMap((site) => site.hosts.map((host) => `https://${host}/*`));
}
