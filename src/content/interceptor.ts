import { analyzeMessage, needsContextAnalysis, type AiFindings, type AnalysisSettings } from "../engine/analysis";
import {
  anonymizeText,
  createAliasRegistry,
  entityKey,
  serializeRegistry,
  type AliasRegistry,
} from "../engine/anonymize";
import type { SensitiveEntity } from "../engine/detect";
import type { ContextVerdict } from "../engine/llmPrompt";
import { expandOccurrences, protect, validateTransformation, verifyEditorContent } from "../engine/protect";
import type { TaskProfile } from "../engine/task";
import { findCorrections, type Correction } from "../shared/learning";
import type { Settings } from "../shared/settings";
import type { SupportedSite } from "../shared/sites";
import type { Stats } from "../shared/stats";
import { showProblemDialog, showProgress, showReviewDialog, showToast } from "./dialog";
import { readEditorText, writeEditorText } from "./editor";

export type AiAnalyzer = (
  text: string,
  kinds: { ner: boolean; llm: boolean },
  timeoutMs: number
) => Promise<AiFindings>;

export type InterceptorOptions = {
  doc: Document;
  site: SupportedSite;
  getSettings: () => Settings;
  aliases?: AliasRegistry;
  /** Moteur IA (document offscreen) ; absent = règles uniquement. */
  analyzeAi?: AiAnalyzer;
  /** Appelé quand de nouveaux alias ont été attribués (persistance, panneau). */
  onAliasesChanged?: (aliases: AliasRegistry) => void;
  onStats?: (delta: Partial<Stats>) => void;
  /** Cases cochées ou décochées par rapport à la proposition, après un envoi protégé réussi. */
  onCorrections?: (corrections: Correction[]) => void;
  /** Délai maximal d'attente de la réactivation du bouton d'envoi. */
  sendTimeoutMs?: number;
  /** Délai maximal d'une analyse IA (chargement du modèle compris). */
  aiTimeoutMs?: number;
};

type Analysis = {
  entities: SensitiveEntity[];
  kept: SensitiveEntity[];
  task: TaskProfile;
  verdict: ContextVerdict | null;
  engines: string;
};

const STRICT_BLOCK_TITLE = "Envoi bloqué";
const NON_STRICT_TITLE = "Protection impossible";

function analysisSettings(settings: Settings): AnalysisSettings {
  return {
    categories: settings.categories,
    customTerms: settings.customTerms,
    level: settings.privacyLevel,
    allowTerms: settings.learning ? settings.allowTerms : [],
  };
}

export function aiKindsFor(settings: Settings, text: string) {
  return {
    ner: settings.ai.ner && settings.categories.includes("identities"),
    llm: settings.ai.llm && settings.categories.includes("context") && needsContextAnalysis(text),
  };
}

export function installInterceptor(options: InterceptorOptions): () => void {
  const { doc, site, getSettings } = options;
  const aliases = options.aliases ?? createAliasRegistry();
  const sendTimeoutMs = options.sendTimeoutMs ?? 1500;
  // Large : le premier chargement de Gemma (≈ 760 Mo) peut dépasser une minute.
  const aiTimeoutMs = options.aiTimeoutMs ?? 180_000;
  const stats = options.onStats ?? (() => {});
  const win = doc.defaultView!;
  const editorSelector = site.editorSelectors.join(",");
  const sendSelector = site.sendButtonSelectors.join(",");

  // Vrai pendant que Cloakly relance lui-même l'envoi : on laisse passer.
  let bypass = false;
  let busy = false;

  function findEditor(origin?: EventTarget | null): HTMLElement | null {
    if (origin instanceof win.Element) {
      const own = origin.closest<HTMLElement>(editorSelector);
      if (own) return own;
    }
    for (const selector of site.editorSelectors) {
      const editor = doc.querySelector<HTMLElement>(selector);
      if (editor) return editor;
    }
    return null;
  }

  async function waitForSendButton(): Promise<HTMLButtonElement | null> {
    const deadline = Date.now() + sendTimeoutMs;
    for (;;) {
      const button = doc.querySelector<HTMLButtonElement>(sendSelector);
      const usable = button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
      if (usable || Date.now() >= deadline) return usable ? button : null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function resubmit(editor: HTMLElement) {
    const button = await waitForSendButton();
    bypass = true;
    try {
      if (button) {
        button.click();
      } else {
        editor.dispatchEvent(
          new win.KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
            cancelable: true,
          })
        );
      }
    } finally {
      bypass = false;
    }
  }

  async function sendUnprotected(editor: HTMLElement) {
    await resubmit(editor);
    showToast(doc, "Message envoyé sans protection.", "warning");
  }

  async function reportProblem(editor: HTMLElement, message: string) {
    const strict = getSettings().strictMode;
    stats({ blocked: 1 });
    const choice = await showProblemDialog(doc, {
      title: strict ? STRICT_BLOCK_TITLE : NON_STRICT_TITLE,
      message: strict
        ? `${message} Le mode strict empêche l'envoi tant que la protection n'est pas vérifiée. Rien n'a été envoyé.`
        : `${message} Votre message n'est pas protégé.`,
      allowSendAnyway: !strict,
    });
    if (choice === "send-anyway") await sendUnprotected(editor);
  }

  function rulesOnly(text: string, settings: Settings): Analysis {
    const analysis = analyzeMessage(text, analysisSettings(settings), null, aliases);
    return { ...analysis, verdict: null, engines: "règles" };
  }

  async function analyzeWithAi(text: string, settings: Settings, kinds: { ner: boolean; llm: boolean }): Promise<Analysis> {
    const models = [kinds.ner && "NER", kinds.llm && "LLM"].filter(Boolean).join(" + ");
    const started = Date.now();
    // Affiché tout de suite : l'utilisateur voit que l'IA locale travaille et depuis combien de temps.
    const progress = showProgress(doc, `🧠 IA locale (${models}) : analyse en cours…`);
    const ticker = setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1000);
      progress.update(
        seconds >= 10
          ? `🧠 IA locale (${models}) : analyse en cours… ${seconds} s (le premier chargement du modèle peut prendre une minute)`
          : `🧠 IA locale (${models}) : analyse en cours… ${seconds} s`
      );
    }, 1000);

    try {
      const findings = await options.analyzeAi!(text, kinds, aiTimeoutMs);
      if (!settings.ai.locations && findings.ner) {
        findings.ner = findings.ner.filter((entity) => entity.type !== "LOCATION");
      }
      const analysis = analyzeMessage(text, analysisSettings(settings), findings, aliases);
      const entities = expandOccurrences(text, analysis.entities);
      const kept = analysis.kept.filter(
        (entity) => !entities.some((other) => entity.start < other.end && other.start < entity.end)
      );
      const seconds = ((Date.now() - started) / 1000).toFixed(1).replace(".", ",");
      return { entities, kept, task: analysis.task, verdict: findings.verdict, engines: `règles + ${models}, ${seconds} s` };
    } finally {
      clearInterval(ticker);
      progress.close();
    }
  }

  /**
   * Un verdict du LLM sans extrait vérifiable ne suffit pas à interrompre
   * l'utilisateur : à l'évaluation, ces verdicts-là étaient surtout des faux
   * positifs (« Comment Napoléon a-t-il perdu à Waterloo ? » jugé à risque).
   */
  function needsReview(analysis: Analysis): boolean {
    return analysis.entities.length > 0;
  }

  function previewFor(text: string, analysis: Analysis, settings: Settings) {
    return (selected: SensitiveEntity[]) => {
      // Registre copié : l'aperçu ne doit pas réserver d'alias.
      const scratch = createAliasRegistry(serializeRegistry(aliases));
      const result = anonymizeText(text, selected, scratch);
      const map = new Map<string, string>();
      for (const item of result.replacements) {
        map.set(entityKey({ type: item.type, value: item.original }), item.alias);
      }
      // Risques pour la tâche (montant masqué, consigne masquée…), mis à jour à chaque case cochée.
      const warnings = validateTransformation({
        original: text,
        sanitized: result.text,
        spans: result.spans,
        settings: analysisSettings(settings),
        task: analysis.task,
      })
        .filter((issue) => issue.severity === "warn")
        .map((issue) => issue.message);
      return { text: result.text, aliases: map, warnings };
    };
  }

  async function review(editor: HTMLElement, text: string, analysis: Analysis) {
    const settings = getSettings();
    const { choice, selected, kept } = await showReviewDialog(doc, {
      entities: analysis.entities,
      kept: analysis.kept,
      task: analysis.task,
      verdict: analysis.verdict,
      strictMode: settings.strictMode,
      preview: previewFor(text, analysis, settings),
      engines: analysis.engines,
    });

    if (choice === "cancel") {
      stats({ blocked: 1 });
      return;
    }

    if (choice === "send-original" || selected.length === 0) {
      await sendUnprotected(editor);
      return;
    }

    const protection = protect(text, selected, analysisSettings(settings), aliases, kept);
    options.onAliasesChanged?.(aliases);

    if (!protection.verified) {
      // Raisons sans aucune valeur d'origine : rien de sensible dans l'interface ni les journaux.
      const reasons = protection.issues.filter((issue) => issue.severity === "block").map((issue) => issue.message);
      await reportProblem(editor, `La vérification de la version pseudonymisée a échoué : ${reasons.join(" ; ")}.`);
      return;
    }

    const written = await writeEditorText(editor, protection.sanitized);
    const verified =
      written &&
      verifyEditorContent(
        readEditorText(editor),
        protection.sanitized,
        analysisSettings(settings),
        protection.spans.map((span) => span.original),
        kept
      );

    if (!verified) {
      await reportProblem(
        editor,
        "Cloakly n'a pas réussi à remplacer le texte dans la zone de saisie de façon vérifiable."
      );
      return;
    }

    await resubmit(editor);
    const count = new Set(protection.replacements.map((item) => item.alias)).size;
    stats({ protected: 1, masked: protection.replacements.length });
    const corrections = findCorrections(analysis, selected);
    if (corrections.length && settings.learning) options.onCorrections?.(corrections);
    showToast(
      doc,
      `Message protégé : ${count} donnée${count > 1 ? "s" : ""} sensible${count > 1 ? "s" : ""} remplacée${count > 1 ? "s" : ""} avant l'envoi.`,
      "success"
    );
  }

  /** Analyse IA puis revue ; en cas d'échec de l'IA, propose de continuer avec les règles. */
  async function processWithAi(editor: HTMLElement, text: string, kinds: { ner: boolean; llm: boolean }) {
    const settings = getSettings();
    let analysis: Analysis;

    try {
      analysis = await analyzeWithAi(text, settings, kinds);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const choice = await showProblemDialog(doc, {
        title: "Analyse IA indisponible",
        message: `L'analyse par l'IA locale n'a pas abouti (${reason}). Vous pouvez analyser le message avec les règles seules, ou désactiver l'IA dans Cloakly si le problème persiste.`,
        allowSendAnyway: !settings.strictMode,
        allowFallback: true,
      });
      if (choice === "send-anyway") {
        await sendUnprotected(editor);
        return;
      }
      if (choice === "cancel") {
        stats({ blocked: 1 });
        return;
      }
      analysis = rulesOnly(text, settings);
    }

    if (needsReview(analysis)) await review(editor, text, analysis);
    else {
      await resubmit(editor);
      // Preuve visible que l'IA a bien tourné, même quand elle ne trouve rien.
      showToast(doc, `✓ Analysé localement (${analysis.engines}) : rien de sensible.`, "success", 3500);
    }
  }

  function block(event: Event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function run(task: Promise<void>) {
    busy = true;
    task
      .catch((error: unknown) =>
        showProblemDialog(doc, {
          title: STRICT_BLOCK_TITLE,
          message: `Erreur inattendue de Cloakly : ${error instanceof Error ? error.message : String(error)}. Rien n'a été envoyé.`,
          allowSendAnyway: false,
        })
      )
      .finally(() => {
        busy = false;
      });
  }

  /** Décide de façon synchrone s'il faut bloquer l'envoi en cours. */
  function intercept(event: Event, origin: EventTarget | null) {
    const settings = getSettings();
    if (bypass || !settings.enabled) return;

    if (busy) {
      block(event);
      return;
    }

    const editor = findEditor(origin);
    let text: string;
    let analysis: Analysis | null = null;
    let kinds = { ner: false, llm: false };

    try {
      if (!editor) throw new Error("Zone de saisie introuvable.");
      text = readEditorText(editor);
      if (!text.trim()) return;
      if (options.analyzeAi) kinds = aiKindsFor(settings, text);
      if (!kinds.ner && !kinds.llm) analysis = rulesOnly(text, settings);
    } catch (error) {
      if (!settings.strictMode) {
        showToast(doc, "Cloakly n'a pas pu analyser ce message : il est envoyé sans protection.", "warning");
        return;
      }
      block(event);
      stats({ blocked: 1 });
      const reason = error instanceof Error ? error.message : String(error);
      run(
        showProblemDialog(doc, {
          title: STRICT_BLOCK_TITLE,
          message: `Cloakly n'a pas pu analyser votre message (${reason}) Le mode strict empêche l'envoi. Rien n'a été envoyé.`,
          allowSendAnyway: false,
        }).then(() => {})
      );
      return;
    }

    stats({ analyzed: 1 });

    // Règles seules et rien de détecté : l'envoi suit son cours normalement.
    if (analysis && !needsReview(analysis)) return;

    block(event);
    run(analysis ? review(editor!, text, analysis) : processWithAi(editor!, text, kinds));
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    if (!(event.target instanceof win.Element) || !event.target.closest(editorSelector)) return;
    intercept(event, event.target);
  };

  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof win.Element) || !event.target.closest(sendSelector)) return;
    intercept(event, null);
  };

  const onSubmit = (event: SubmitEvent) => {
    if (!(event.target instanceof win.HTMLFormElement)) return;
    const editor = event.target.querySelector(editorSelector);
    if (editor) intercept(event, editor);
  };

  win.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("click", onClick, true);
  win.addEventListener("submit", onSubmit, true);

  return () => {
    win.removeEventListener("keydown", onKeyDown, true);
    win.removeEventListener("click", onClick, true);
    win.removeEventListener("submit", onSubmit, true);
  };
}
