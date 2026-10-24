import { entityKey } from "../engine/anonymize";
import { ENTITY_LABELS, isLocked, type SensitiveEntity } from "../engine/detect";
import type { ContextVerdict, RiskLevel } from "../engine/llmPrompt";
import { TASK_LABELS, type SensitiveContext, type TaskProfile } from "../engine/task";

export type ReviewChoice = "protect" | "send-original" | "cancel";
export type ReviewResult = { choice: ReviewChoice; selected: SensitiveEntity[]; kept: SensitiveEntity[] };
export type ProblemChoice = "send-anyway" | "fallback" | "cancel";

export const HOST_ID = "cloakly-root";

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.backdrop {
  position: fixed; inset: 0; z-index: 2147483647;
  display: grid; place-items: center; padding: 16px;
  background: rgb(10 20 30 / 55%);
}
.dialog {
  width: min(620px, 100%); max-height: calc(100vh - 32px); overflow: auto;
  padding: 22px; border-radius: 16px; background: #fff; color: #17212b;
  box-shadow: 0 20px 60px rgb(0 0 0 / 30%);
}
.title { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; font-size: 18px; }
.badge {
  display: grid; place-items: center; width: 30px; height: 30px; flex-shrink: 0;
  border-radius: 9px; background: #2b2d6e; color: #fff; font-size: 15px; font-weight: 800;
}
.dialog.danger .badge { background: #b42318; }
p { margin: 0; color: #4d5b67; font-size: 13px; line-height: 1.55; }
h3 { margin: 16px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #697784; }
.verdict { margin-top: 14px; padding: 11px 13px; border-radius: 10px; font-size: 13px; line-height: 1.5; }
.verdict strong { display: block; margin-bottom: 2px; }
.verdict.high { background: #fef3f2; color: #8a1c12; border: 1px solid #f4b8b0; }
.verdict.medium { background: #fff7e6; color: #7a4a00; border: 1px solid #f0d9a8; }
.verdict.low, .verdict.none { background: #f2f5f7; color: #4d5b67; border: 1px solid #e1e7ec; }
ul.items { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
ul.items li label {
  display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px;
  padding: 7px 9px; border-radius: 9px; border: 1px solid #edf0f2; cursor: pointer; font-size: 12px;
}
ul.items li label:hover { background: #f8fafb; }
ul.items input { width: 16px; height: 16px; margin: 0; accent-color: #2b2d6e; }
ul.items input:disabled + .copy { opacity: .9; }
.copy { display: grid; gap: 2px; min-width: 0; }
.kind { color: #697784; font-size: 11px; }
.source { margin-left: 6px; padding: 1px 6px; border-radius: 10px; background: #eef0fb; color: #2b2d6e; font-size: 10px; font-weight: 700; }
.value { color: #8a1c12; word-break: break-all; }
.alias { font-family: ui-monospace, Consolas, monospace; color: #18794e; white-space: nowrap; }
.unchecked .alias { color: #9aa5af; text-decoration: line-through; }
.kept .value { color: #4d5b67; }
.reason { color: #697784; font-size: 11px; }
.task { margin-top: 10px; padding: 9px 12px; border-radius: 10px; background: #f2f5f7; color: #4d5b67; font-size: 12px; line-height: 1.5; }
.warnings { margin-top: 10px; padding: 9px 12px; border-radius: 10px; background: #fff7e6; color: #7a4a00; border: 1px solid #f0d9a8; font-size: 12px; }
.warnings[hidden] { display: none; }
.locked { color: #697784; font-size: 11px; margin-top: 6px; }
pre {
  margin: 0; max-height: 180px; overflow: auto; padding: 12px; border-radius: 10px;
  background: #f2f5f7; color: #17212b; font: 12px/1.5 ui-monospace, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word;
}
.note { margin-top: 12px; font-size: 12px; }
.engines {
  display: inline-block; margin: 2px 0 10px; padding: 4px 10px; border-radius: 20px;
  background: #eef0fb; color: #2b2d6e; font-size: 12px; font-weight: 600;
}
.toast.progress { background: #2b2d6e; }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 18px; }
button {
  padding: 9px 14px; border: 1px solid #c9d0d7; border-radius: 9px; background: #fff;
  color: #17212b; font-size: 13px; font-weight: 600; cursor: pointer;
}
button:hover { background: #f2f5f7; }
button.primary { border-color: #2b2d6e; background: #2b2d6e; color: #fff; }
button.primary:hover { background: #1f2056; }
button.warning { border-color: #b42318; color: #b42318; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 3px solid #8abcf5; outline-offset: 2px; }
.toast {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; max-width: 380px;
  padding: 12px 14px; border-radius: 12px; background: #17212b; color: #fff;
  font-size: 13px; line-height: 1.45; box-shadow: 0 10px 30px rgb(0 0 0 / 25%);
}
.toast.success { background: #18794e; }
.toast.warning { background: #9a4a00; }
`;

/**
 * Racine fermée : le script du site (donc le fournisseur d'IA) ne peut pas
 * lire `host.shadowRoot`, où s'affichent les valeurs d'origine et la table
 * de correspondance. Seul le content script en garde la référence.
 */
const roots = new WeakMap<Document, { host: HTMLElement; root: ShadowRoot }>();

export function getRoot(doc: Document): ShadowRoot {
  const existing = roots.get(doc);
  if (existing?.host.isConnected) return existing.root;

  const host = doc.createElement("div");
  host.id = HOST_ID;
  // Empêche les raccourcis clavier du site de réagir aux touches tapées dans nos boîtes.
  for (const type of ["keydown", "keyup", "keypress"]) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }
  doc.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  style.textContent = STYLES;
  root.appendChild(style);
  roots.set(doc, { host, root });
  return root;
}

/** Racine déjà créée, sans en créer une (tests, nettoyage). */
export function existingRoot(doc: Document): ShadowRoot | null {
  const existing = roots.get(doc);
  return existing?.host.isConnected ? existing.root : null;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: { className?: string; text?: string } = {},
  children: Node[] = []
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  node.append(...children);
  return node;
}

type Action<T> = { label: string; value: T; variant?: "primary" | "warning" };

function openModal<T>(
  doc: Document,
  options: {
    title: string;
    danger?: boolean;
    body: Node[];
    actions: Action<T>[];
    cancelValue: T;
  }
): Promise<T> {
  const root = getRoot(doc);
  const previousFocus = doc.activeElement as HTMLElement | null;
  const titleId = `cloakly-title-${Date.now()}`;

  const buttons = options.actions.map((action) => {
    const button = el(doc, "button", { className: action.variant, text: action.label });
    button.type = "button";
    return button;
  });

  const title = el(doc, "h2", { className: "title" }, [
    el(doc, "span", { className: "badge", text: options.danger ? "!" : "C" }),
    doc.createTextNode(options.title),
  ]);
  title.id = titleId;

  const dialog = el(doc, "div", { className: `dialog${options.danger ? " danger" : ""}` }, [
    title,
    ...options.body,
    el(doc, "div", { className: "actions" }, buttons),
  ]);
  dialog.setAttribute("role", options.danger ? "alertdialog" : "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", titleId);

  const backdrop = el(doc, "div", { className: "backdrop" }, [dialog]);
  root.appendChild(backdrop);

  return new Promise<T>((resolve) => {
    const close = (value: T) => {
      backdrop.remove();
      previousFocus?.focus?.();
      resolve(value);
    };

    buttons.forEach((button, index) =>
      button.addEventListener("click", () => close(options.actions[index].value))
    );

    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(options.cancelValue);
      } else if (event.key === "Tab") {
        // Piège à focus : on reste dans la boîte de dialogue.
        const focusable = [
          ...dialog.querySelectorAll<HTMLElement>("input:not([disabled]), button"),
        ];
        const current = focusable.indexOf(root.activeElement as HTMLElement);
        const next = event.shiftKey
          ? (current - 1 + focusable.length) % focusable.length
          : (current + 1) % focusable.length;
        event.preventDefault();
        focusable[next].focus();
      }
    });

    const primary = buttons.find((button) => button.classList.contains("primary")) ?? buttons[0];
    primary.focus();
  });
}

const RISK_TITLES: Record<RiskLevel, string> = {
  high: "Analyse IA : risque élevé",
  medium: "Analyse IA : risque modéré",
  low: "Analyse IA : risque faible",
  none: "Analyse IA : aucun risque identifié",
};

const SOURCE_LABELS = { rules: "règle", memory: "déjà masqué", ner: "IA · NER", llm: "IA · contexte" } as const;

const CONTEXT_LABELS: Record<SensitiveContext, string> = {
  health: "santé",
  finance: "finances personnelles",
  children: "enfants",
  intimate: "vie privée",
  legal: "justice",
};

export type ReviewPreview = { text: string; aliases: Map<string, string>; warnings: string[] };

export function showReviewDialog(
  doc: Document,
  details: {
    entities: SensitiveEntity[];
    /** Candidats conservés car utiles à la tâche : proposés décochés. */
    kept?: SensitiveEntity[];
    task?: TaskProfile;
    verdict: ContextVerdict | null;
    strictMode: boolean;
    /** Calcule le texte envoyé, l'alias de chaque groupe et les risques pour la tâche. */
    preview: (selected: SensitiveEntity[]) => ReviewPreview;
    engines: string;
  }
): Promise<ReviewResult> {
  const candidates = [...details.entities, ...(details.kept ?? [])];
  const maskedKeys = new Set(details.entities.map(entityKey));
  // Une case par valeur : toutes les occurrences de « Marc » vont ensemble.
  const groups = new Map<string, SensitiveEntity[]>();
  for (const entity of candidates) {
    const key = entityKey(entity);
    groups.set(key, [...(groups.get(key) ?? []), entity]);
  }

  const checked = new Map([...groups.keys()].map((key) => [key, maskedKeys.has(key)]));
  const selectedEntities = () => candidates.filter((entity) => checked.get(entityKey(entity)));
  const keptEntities = () => candidates.filter((entity) => !checked.get(entityKey(entity)));

  const pre = el(doc, "pre");
  const warnings = el(doc, "div", { className: "warnings" });
  warnings.setAttribute("role", "status");
  const aliasCells = new Map<string, HTMLElement>();
  const rows = new Map<string, HTMLElement>();
  let anyLocked = false;

  const items = [...groups.entries()].map(([key, members]) => {
    const first = members[0];
    const source = first.source ?? "rules";
    const conserved = !maskedKeys.has(key);
    const locked = !conserved && isLocked(first, details.strictMode);
    anyLocked ||= locked;

    const input = el(doc, "input");
    input.type = "checkbox";
    input.checked = !conserved;
    input.disabled = locked;
    input.setAttribute(
      "aria-label",
      `Masquer ${ENTITY_LABELS[first.type]} ${first.value}${locked ? " (obligatoire)" : ""}`
    );

    const alias = el(doc, "span", { className: "alias" });
    aliasCells.set(key, alias);

    const count = members.length > 1 ? ` (×${members.length})` : "";
    const kind = el(doc, "span", { className: "kind", text: ENTITY_LABELS[first.type] + count }, [
      el(doc, "span", { className: "source", text: SOURCE_LABELS[source] }),
    ]);
    const copy = [kind, el(doc, "span", { className: "value", text: first.value })];
    if (conserved && first.reason) copy.push(el(doc, "span", { className: "reason", text: `Conservé : ${first.reason}` }));

    const label = el(doc, "label", {}, [input, el(doc, "span", { className: "copy" }, copy), alias]);
    const row = el(doc, "li", { className: conserved ? "kept" : undefined }, [label]);
    rows.set(key, row);

    input.addEventListener("change", () => {
      checked.set(key, input.checked);
      refresh();
    });
    return row;
  });

  function refresh() {
    const { text, aliases, warnings: risks } = details.preview(selectedEntities());
    pre.textContent = text;
    warnings.hidden = risks.length === 0;
    warnings.textContent = risks.length ? `⚠ Attention : ${risks.join(" ; ")}.` : "";
    for (const [key, cell] of aliasCells) {
      const isChecked = checked.get(key) ?? false;
      cell.textContent = isChecked ? (aliases.get(key) ?? "") : "conservé";
      rows.get(key)?.classList.toggle("unchecked", !isChecked);
    }
  }
  refresh();

  const toMask = maskedKeys.size;
  const body: Node[] = [
    // Montre explicitement quels moteurs ont analysé le message, IA locale comprise.
    el(doc, "p", { className: "engines", text: `🧠 Analyse locale : ${details.engines}` }),
    el(doc, "p", {
      text: `Cloakly a trouvé ${toMask} donnée${toMask > 1 ? "s" : ""} sensible${toMask > 1 ? "s" : ""}. Décochez celles que vous voulez garder, puis vérifiez le message.`,
    }),
  ];

  const task = details.task;
  if (task && (task.kinds.length > 0 || task.sensitiveContexts.length > 0)) {
    const parts: string[] = [];
    if (task.kinds.length) parts.push(`Demande reconnue : ${task.kinds.map((kind) => TASK_LABELS[kind]).join(", ")}.`);
    if (task.parameters.length) {
      const plural = task.parameters.length > 1 ? "s" : "";
      parts.push(`${task.parameters.length} paramètre${plural} utile${plural} (montants, dates, codes…) conservé${plural}.`);
    }
    if (task.sensitiveContexts.length) {
      parts.push(
        `Contexte sensible (${task.sensitiveContexts.map((context) => CONTEXT_LABELS[context]).join(", ")}) : les identifiants sont retirés, le contenu utile à la demande est gardé.`
      );
    }
    body.push(el(doc, "p", { className: "task", text: parts.join(" ") }));
  }

  if (details.verdict && details.verdict.risk !== "none") {
    body.push(
      el(doc, "div", { className: `verdict ${details.verdict.risk}` }, [
        el(doc, "strong", { text: RISK_TITLES[details.verdict.risk] }),
        doc.createTextNode(details.verdict.reason || "Le contexte du message paraît confidentiel."),
      ])
    );
  }

  body.push(el(doc, "h3", { text: "Données détectées" }), el(doc, "ul", { className: "items" }, items));
  if (anyLocked) {
    body.push(
      el(doc, "p", {
        className: "locked",
        text: "Les secrets (clés, mots de passe) sont toujours masqués ; en mode strict, les données au format vérifié (e-mails, IBAN…) aussi.",
      })
    );
  }

  body.push(
    el(doc, "h3", { text: "Message qui sera envoyé" }),
    pre,
    warnings,
    el(doc, "p", {
      className: "note",
      text: "Les valeurs d'origine ne quittent pas votre poste.",
    })
  );

  const actions: Action<ReviewChoice>[] = [{ label: "Annuler", value: "cancel" }];
  if (!details.strictMode) {
    actions.push({ label: "Envoyer sans protéger", value: "send-original", variant: "warning" });
  }
  actions.push({ label: "Remplacer et envoyer", value: "protect", variant: "primary" });

  return openModal(doc, {
    title: "Données sensibles détectées",
    body,
    actions,
    cancelValue: "cancel" as ReviewChoice,
  }).then((choice) => ({ choice, selected: selectedEntities(), kept: keptEntities() }));
}

export function showProblemDialog(
  doc: Document,
  details: { title: string; message: string; allowSendAnyway: boolean; allowFallback?: boolean }
): Promise<ProblemChoice> {
  const actions: Action<ProblemChoice>[] = [
    { label: "Revenir au message", value: "cancel", variant: "primary" },
  ];
  if (details.allowFallback) {
    actions.push({ label: "Analyser sans l'IA", value: "fallback" });
  }
  if (details.allowSendAnyway) {
    actions.push({ label: "Envoyer sans protection", value: "send-anyway", variant: "warning" });
  }

  return openModal(doc, {
    title: details.title,
    danger: true,
    body: [el(doc, "p", { text: details.message })],
    actions,
    cancelValue: "cancel",
  });
}

/** Bandeau persistant pendant une opération longue (analyse IA), mis à jour en direct. */
export function showProgress(doc: Document, message: string): { update(text: string): void; close(): void } {
  const root = getRoot(doc);
  root.querySelector(".toast")?.remove();
  const toast = el(doc, "div", { className: "toast progress", text: message });
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  root.appendChild(toast);
  return {
    update: (text) => {
      toast.textContent = text;
    },
    close: () => toast.remove(),
  };
}

export function showToast(
  doc: Document,
  message: string,
  tone: "success" | "warning" | "info" = "info",
  durationMs = 4500
): () => void {
  const root = getRoot(doc);
  root.querySelector(".toast")?.remove();

  const toast = el(doc, "div", { className: `toast ${tone}`, text: message });
  toast.setAttribute("role", "status");
  root.appendChild(toast);
  const timer = setTimeout(() => toast.remove(), durationMs);
  return () => {
    clearTimeout(timer);
    toast.remove();
  };
}
