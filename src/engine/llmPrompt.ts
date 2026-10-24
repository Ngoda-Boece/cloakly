export type RiskLevel = "none" | "low" | "medium" | "high";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ContextVerdict = {
  risk: RiskLevel;
  reason: string;
  /** Extraits confidentiels, rattachés à un passage réel du message. */
  excerpts: { value: string; start: number; end: number }[];
  /** Extraits proposés par le modèle mais introuvables dans le message (diagnostic). */
  rejected?: string[];
};

const SYSTEM_PROMPT = `You are a data-leak detector. The user pastes a message they want to send to a public AI chatbot.
Decide whether the message reveals CONFIDENTIAL information, such as:
- unannounced business plans (mergers, acquisitions, layoffs, closures, launches)
- non-public financial figures, salaries, prices negotiated with a client
- health, medical, legal or family details about an identifiable person
- internal security details, customer data, contracts
General knowledge questions, public facts, code questions and creative requests are NOT confidential.

Answer in exactly this format and nothing else:
RISK: none|low|medium|high
REASON: <one short sentence in French>
EXCERPTS:
- <short excerpt copied word for word from the message>

Each excerpt is the shortest phrase that carries the confidential fact (2 to 8 words),
copied exactly as written, in the language of the message. Never translate it.
Write "EXCERPTS: none" when nothing is confidential.`;

const EXAMPLES: ChatMessage[] = [
  {
    role: "user",
    content: 'Message:\n"""\nTraduis en anglais : la direction va annoncer la fermeture du site de Rennes en juin, 40 postes supprimés.\n"""',
  },
  {
    role: "assistant",
    content:
      "RISK: high\nREASON: Le message révèle une fermeture de site et des suppressions de postes non annoncées.\nEXCERPTS:\n- la fermeture du site de Rennes en juin\n- 40 postes supprimés",
  },
  {
    role: "user",
    content: 'Message:\n"""\nQuelle est la capitale de l\'Australie ?\n"""',
  },
  {
    role: "assistant",
    content: "RISK: none\nREASON: Question de culture générale.\nEXCERPTS: none",
  },
];

/** Au-delà, le message est tronqué : le mini-LLM perd en fiabilité sur les textes longs. */
export const MAX_LLM_INPUT_CHARS = 2000;

export function buildMessages(text: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...EXAMPLES,
    { role: "user", content: `Message:\n"""\n${text.slice(0, MAX_LLM_INPUT_CHARS)}\n"""` },
  ];
}

const RISKS: RiskLevel[] = ["none", "low", "medium", "high"];

type Token = { norm: string; start: number; end: number };

function tokenize(value: string): Token[] {
  return [...value.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    norm: match[0].normalize("NFD").replace(/\p{M}/gu, "").toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** Mot porteur de sens : chiffre, ou au moins 4 lettres. */
const isContent = (token: string) => /\d/.test(token) || token.length >= 4;

/** Égalité tolérante aux flexions : « poursuite » ≈ « poursuivi », « fixée » ≈ « fixées ». */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5);
}

/**
 * Retrouve dans le message le passage auquel un extrait correspond, même si le
 * modèle l'a légèrement reformulé (« poursuite pour fraude fiscale » pour
 * « poursuivi pour fraude fiscale »). Retourne null si l'extrait est inventé.
 */
export function alignExcerpt(excerpt: string, text: string): { start: number; end: number } | null {
  const exact = text.toLowerCase().indexOf(excerpt.toLowerCase());
  if (exact !== -1) return { start: exact, end: exact + excerpt.length };

  const wanted = tokenize(excerpt).map((token) => token.norm);
  const content = wanted.filter(isContent);
  if (content.length < 2) return null;

  const words = tokenize(text);
  const span = wanted.length + 3;
  let best: { score: number; first: number; last: number } | null = null;

  for (let start = 0; start < words.length; start += 1) {
    if (!wanted.some((word) => sameWord(word, words[start].norm))) continue;
    const window = words.slice(start, start + span);
    const used = new Set<number>();
    let score = 0;
    let last = start;

    for (const word of content) {
      const index = window.findIndex((token, i) => !used.has(i) && sameWord(word, token.norm));
      if (index === -1) continue;
      used.add(index);
      score += 1;
    }
    // Le passage s'étend jusqu'au dernier mot de l'extrait retrouvé (y compris « au », « de »…).
    window.forEach((token, i) => {
      if (wanted.some((word) => sameWord(word, token.norm))) last = Math.max(last, start + i);
    });

    if (!best || score > best.score) best = { score, first: start, last };
  }

  if (!best || best.score < Math.max(2, Math.ceil(content.length * 0.6))) return null;
  return { start: words[best.first].start, end: words[best.last].end };
}

/**
 * Interprète la réponse du modèle. Chaque extrait est rattaché à un passage
 * réel du message ; un extrait introuvable (inventé, traduit) est écarté et
 * listé dans `rejected` pour le diagnostic.
 */
export function parseVerdict(reply: string, text: string): ContextVerdict {
  const riskMatch = /RISK\s*:\s*(none|low|medium|high)/i.exec(reply);
  const reasonMatch = /REASON\s*:\s*(.+)/i.exec(reply);
  const excerptBlock = /EXCERPTS\s*:([\s\S]*)/i.exec(reply)?.[1] ?? "";

  const excerpts: ContextVerdict["excerpts"] = [];
  const rejected: string[] = [];

  for (const line of excerptBlock.split("\n")) {
    const proposed = line
      .replace(/^\s*[-*•]\s*/, "")
      .trim()
      .replace(/^["'«“]\s*|\s*["'»”]$/g, "")
      .replace(/[.;,]$/, "")
      .trim();

    if (proposed.length < 3 || /^none$/i.test(proposed)) continue;

    const span = alignExcerpt(proposed, text);
    // Un extrait qui couvre presque tout le message n'aide pas à pseudonymiser.
    const length = span ? span.end - span.start : 0;
    if (!span || length > 200 || length >= text.trim().length * 0.8) {
      rejected.push(proposed);
      continue;
    }
    if (excerpts.some((item) => span.start < item.end && item.start < span.end)) continue;

    excerpts.push({ value: text.slice(span.start, span.end), ...span });
  }

  let risk: RiskLevel = riskMatch ? (riskMatch[1].toLowerCase() as RiskLevel) : "none";
  // Un modèle qui cite des extraits mais annonce "none" se contredit : on retient le signal.
  if (risk === "none" && excerpts.length > 0) risk = "low";

  return {
    risk: RISKS.includes(risk) ? risk : "none",
    reason: reasonMatch?.[1].trim() ?? "",
    excerpts: excerpts.sort((a, b) => a.start - b.start),
    rejected,
  };
}
