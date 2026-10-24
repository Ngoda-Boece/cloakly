import { restoreText, type AliasRegistry } from "../engine/anonymize";
import { ENTITY_LABELS } from "../engine/detect";
import { el, getRoot } from "./dialog";

const PANEL_STYLES = `
.fab {
  position: fixed; left: 16px; bottom: 16px; z-index: 2147483646;
  display: flex; align-items: center; gap: 6px; padding: 7px 11px;
  border: 0; border-radius: 20px; background: var(--brand); color: #fff;
  font-size: 12px; font-weight: 700; box-shadow: 0 6px 18px rgb(0 0 0 / 20%); cursor: pointer;
}
.fab:hover { background: var(--brand-hover); }
.fab[hidden] { display: none; }
.panel {
  position: fixed; left: 16px; bottom: 60px; z-index: 2147483646;
  width: min(420px, calc(100vw - 32px)); max-height: min(560px, calc(100vh - 90px)); overflow: auto;
  padding: 16px; border-radius: 14px; background: var(--bg); color: var(--text);
  border: 1px solid var(--line-soft); box-shadow: 0 16px 50px rgb(0 0 0 / 28%);
}
.panel h2 { margin: 0 0 4px; font-size: 15px; }
.panel table { width: 100%; border-collapse: collapse; font-size: 12px; }
.panel td { padding: 5px 6px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
.panel td.original { word-break: break-all; }
.panel textarea {
  width: 100%; min-height: 90px; margin-top: 8px; padding: 8px; border: 1px solid var(--control);
  border-radius: 9px; background: var(--bg); color: var(--text);
  font: 12px/1.5 ui-monospace, Consolas, monospace; resize: vertical;
}
.panel .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; }
.panel .muted { color: var(--muted); font-size: 11px; }
`;

/**
 * Bouton flottant « Cloakly · N alias » : table de correspondance de l'onglet
 * et restauration des vraies valeurs dans une réponse copiée depuis l'IA.
 * Rien n'est modifié dans la page du site.
 */
export function createAliasPanel(doc: Document, aliases: AliasRegistry, onClear?: () => void) {
  const root = getRoot(doc);
  const style = doc.createElement("style");
  style.textContent = PANEL_STYLES;
  root.appendChild(style);

  const fab = el(doc, "button", { className: "fab" });
  fab.type = "button";
  fab.setAttribute("aria-expanded", "false");
  fab.hidden = true;
  root.appendChild(fab);

  let panel: HTMLElement | null = null;

  function close() {
    panel?.remove();
    panel = null;
    fab.setAttribute("aria-expanded", "false");
  }

  function open() {
    const entries = [...aliases.values()];
    const input = el(doc, "textarea");
    input.placeholder = "Collez ici la réponse de l'IA pour y remettre les vraies valeurs.";
    input.setAttribute("aria-label", "Réponse à restaurer");
    const output = el(doc, "pre");
    output.hidden = true;
    const copy = el(doc, "button", { text: "Copier le texte restauré" });
    copy.type = "button";
    copy.disabled = true;
    const info = el(doc, "span", { className: "muted" });
    const clear = el(doc, "button", { text: "Effacer les correspondances" });
    clear.type = "button";
    clear.addEventListener("click", () => {
      onClear?.();
      close();
      refresh();
    });

    input.addEventListener("input", () => {
      const { text, restored } = restoreText(input.value, aliases);
      output.textContent = text;
      output.hidden = !input.value;
      copy.disabled = !input.value;
      info.textContent = input.value ? `${restored} alias restauré${restored > 1 ? "s" : ""}` : "";
    });
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(output.textContent ?? "").then(() => {
        copy.textContent = "Copié !";
        setTimeout(() => (copy.textContent = "Copier le texte restauré"), 1500);
      });
    });

    panel = el(doc, "div", { className: "panel" }, [
      el(doc, "h2", { text: "Correspondances de cet onglet" }),
      el(doc, "p", {
        className: "muted",
        text: "Ces valeurs restent sur votre poste. Elles sont effacées à la fermeture du navigateur.",
      }),
      el(
        doc,
        "table",
        {},
        entries.map((entry) =>
          el(doc, "tr", {}, [
            el(doc, "td", { className: "alias", text: entry.alias }),
            el(doc, "td", { className: "original", text: entry.original }),
            el(doc, "td", { className: "kind", text: ENTITY_LABELS[entry.type] }),
          ])
        )
      ),
      el(doc, "h3", { text: "Restaurer une réponse" }),
      input,
      output,
      el(doc, "div", { className: "row" }, [info, copy]),
      el(doc, "div", { className: "row" }, [
        el(doc, "span", { className: "muted", text: "Sans correspondances, les réponses ne pourront plus être restaurées." }),
        clear,
      ]),
    ]);
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Correspondances Cloakly");
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        close();
        fab.focus();
      }
    });
    root.appendChild(panel);
    fab.setAttribute("aria-expanded", "true");
    input.focus();
  }

  fab.addEventListener("click", () => (panel ? close() : open()));

  function refresh() {
    const count = aliases.size;
    fab.hidden = count === 0;
    fab.textContent = `Cloakly · ${count} alias`;
    if (panel) {
      close();
      open();
    }
  }

  return { refresh };
}
