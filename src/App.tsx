import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import "./App.css";
import { analyzeWithAi, getAiStatus, isExtensionContext, loadModels } from "./ai/client";
import { MODELS } from "./ai/models";
import { IDLE_STATUS, type AiStatus, type ModelKind, type ModelState } from "./ai/protocol";
import { analyzeMessage, needsContextAnalysis, type AiFindings } from "./engine/analysis";
import { anonymizeText, createAliasRegistry } from "./engine/anonymize";
import { ENTITY_LABELS, type CategoryId, type SensitiveEntity } from "./engine/detect";
import type { ContextVerdict } from "./engine/llmPrompt";
import { expandOccurrences } from "./engine/protect";
import { loadSettings, saveSettings, type Settings, type Theme } from "./shared/settings";
import { applyDocumentTheme } from "./theme";
import { findSiteForUrl, SUPPORTED_SITES, type SupportedSite } from "./shared/sites";
import { resetLearning } from "./shared/learning";
import { EMPTY_STATS, loadStats, resetStats, type Stats } from "./shared/stats";

const VERSION = "1.1.0";

const categoryOptions: {
  id: CategoryId;
  label: string;
  detail: string;
  ai?: ModelKind;
  /** Fonctionne sans le modèle, qui ne fait qu'améliorer la détection. */
  aiOptional?: boolean;
  /** Toujours analysé, quelle que soit la case. */
  locked?: boolean;
}[] = [
  {
    id: "personal",
    label: "Données personnelles",
    detail: "E-mails, téléphones, adresses, dates de naissance, IBAN, cartes, n° de sécurité sociale, passeport, n° client",
  },
  {
    id: "professional",
    label: "Informations professionnelles",
    detail: "IP publiques, URL internes ; en mode maximal, aussi les n° de commande/ticket et IP privées",
  },
  {
    id: "secrets",
    label: "Mots de passe et secrets",
    detail: "Toujours analysés : clés d'API, jetons, clés privées, mots de passe",
    locked: true,
  },
  { id: "confidential", label: "Termes confidentiels", detail: "Votre liste : clients, projets, noms…" },
  {
    id: "identities",
    label: "Personnes et organisations",
    detail: "Noms repérés par le contexte (civilité, signature…) ; le modèle NER ajoute organisations et lieux",
    ai: "ner",
    aiOptional: true,
  },
  { id: "context", label: "Contexte confidentiel", detail: "Fusions, salaires, santé… jugés par le mini-LLM", ai: "llm" },
];

type Tab = "protection" | "ai" | "test";

type TabStatus =
  | { kind: "unavailable" }
  | { kind: "supported"; site: SupportedSite }
  | { kind: "unsupported" };

async function readTabStatus(): Promise<TabStatus> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return { kind: "unavailable" };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = findSiteForUrl(tab?.url);
  return site ? { kind: "supported", site } : { kind: "unsupported" };
}

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("protection");
  const [tabStatus, setTabStatus] = useState<TabStatus>({ kind: "unavailable" });
  const [aiStatus, setAiStatus] = useState<AiStatus>(IDLE_STATUS);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);

  useEffect(() => {
    loadSettings()
      .then(setSettings)
      .catch(() => setError("Impossible de charger les réglages."));
    readTabStatus()
      .then(setTabStatus)
      .catch(() => setTabStatus({ kind: "unavailable" }));
    loadStats().then(setStats).catch(() => {});
  }, []);

  // Suit l'état des modèles (téléchargement, chargement) tant que le popup est ouvert.
  useEffect(() => {
    if (!isExtensionContext()) return;
    let alive = true;
    const poll = () =>
      getAiStatus()
        .then((status) => alive && setAiStatus(status))
        .catch(() => {});
    void poll();
    const timer = setInterval(poll, 700);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const theme = settings?.theme;
  useEffect(() => {
    if (theme) applyDocumentTheme(theme);
  }, [theme]);

  if (!settings) {
    return (
      <main className="popup">
        <Header />
        <p className={error ? "error-banner" : "loading"} role={error ? "alert" : "status"}>
          {error ?? "Chargement des réglages…"}
        </p>
      </main>
    );
  }

  function update(patch: Partial<Settings>) {
    const previous = settings!;
    const next = { ...previous, ...patch };
    setSettings(next);
    setError(null);
    saveSettings(next).catch(() => {
      setSettings(previous);
      setError("Impossible d'enregistrer les réglages. La modification a été annulée.");
    });
  }

  function enableModel(kind: ModelKind, enabled: boolean) {
    const category: CategoryId = kind === "ner" ? "identities" : "context";
    const categories =
      enabled && !settings!.categories.includes(category)
        ? [...settings!.categories, category]
        : settings!.categories;
    const ai = { ...settings!.ai, [kind]: enabled };
    update({ ai, categories });
    if (enabled) {
      loadModels({ ner: ai.ner, llm: ai.llm })
        .then(setAiStatus)
        .catch((reason: unknown) =>
          setError(
            `Impossible de démarrer le moteur IA : ${reason instanceof Error ? reason.message : String(reason)}`
          )
        );
    }
  }

  const aiActive = settings.ai.ner || settings.ai.llm;

  return (
    <main className="popup">
      <Header
        active={settings.enabled}
        theme={settings.theme}
        onToggleTheme={() => update({ theme: settings.theme === "dark" ? "light" : "dark" })}
      />

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <nav className="tabs" role="tablist" aria-label="Sections">
        {(
          [
            ["protection", "Protection"],
            ["ai", "IA locale"],
            ["test", "Tester"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            className={tab === id ? "tab tab-active" : "tab"}
            onClick={() => setTab(id)}
          >
            {label}
            {id === "ai" && aiActive && <span className="tab-dot" aria-label="(activée)" />}
          </button>
        ))}
      </nav>

      {tab === "protection" && (
        <section role="tabpanel" id="panel-protection" aria-labelledby="tab-protection">
          <ProtectionTab
            settings={settings}
            update={update}
            tabStatus={tabStatus}
            stats={stats}
            onResetStats={() => resetStats().then(() => setStats(EMPTY_STATS))}
          />
        </section>
      )}
      {tab === "ai" && (
        <section role="tabpanel" id="panel-ai" aria-labelledby="tab-ai">
          <AiTab settings={settings} update={update} status={aiStatus} onToggle={enableModel} />
        </section>
      )}
      {tab === "test" && (
        <section role="tabpanel" id="panel-test" aria-labelledby="tab-test">
          <TestTab settings={settings} />
        </section>
      )}

      <footer className="footer">
        <p>
          Analyse 100 % locale : vos messages ne quittent jamais votre poste. Seuls les modèles IA sont
          téléchargés une fois depuis Hugging Face, si vous les activez.
        </p>
        <span>
          Cloakly · v{VERSION} · {SUPPORTED_SITES.map((site) => site.name).join(", ")}
        </span>
      </footer>
    </main>
  );
}

function ProtectionTab(props: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  tabStatus: TabStatus;
  stats: Stats;
  onResetStats: () => void;
}) {
  const { settings, update, tabStatus, stats } = props;
  const [newTerm, setNewTerm] = useState("");
  const noCategory = settings.categories.length === 0;

  function toggleCategory(id: CategoryId) {
    update({
      categories: settings.categories.includes(id)
        ? settings.categories.filter((item) => item !== id)
        : [...settings.categories, id],
    });
  }

  function addTerm(event: FormEvent) {
    event.preventDefault();
    const term = newTerm.trim();
    if (term.length < 2) return;
    if (!settings.customTerms.some((item) => item.toLowerCase() === term.toLowerCase())) {
      update({ customTerms: [...settings.customTerms, term] });
    }
    setNewTerm("");
  }

  return (
    <>
      <div className="card">
        <div className="section-heading">
          <div>
            <h2>Protection</h2>
            <p>{settings.enabled ? "Activée" : "Désactivée"}</p>
          </div>
          <Switch checked={settings.enabled} label="Activer la protection" onChange={(enabled) => update({ enabled })} />
        </div>

        <div className={`status-message ${settings.enabled && !noCategory ? "status-on" : "status-off"}`}>
          <span className="status-icon" aria-hidden="true">
            {settings.enabled && !noCategory ? "✓" : "!"}
          </span>
          <div role="status">
            <strong>
              {!settings.enabled
                ? "Protection désactivée"
                : noCategory
                  ? "Aucune catégorie surveillée"
                  : "Analyse avant chaque envoi"}
            </strong>
            <p>
              {!settings.enabled
                ? "Vos messages sont envoyés tels quels, sans analyse."
                : noCategory
                  ? "Cochez au moins une catégorie pour que Cloakly analyse vos messages."
                  : "Si des données sensibles sont détectées, vous validez la version pseudonymisée avant l'envoi."}
            </p>
          </div>
        </div>

        {tabStatus.kind !== "unavailable" && (
          <p className={`tab-status ${tabStatus.kind}`}>
            {tabStatus.kind === "supported"
              ? `Onglet actuel : ${tabStatus.site.name}, site pris en charge.`
              : "Onglet actuel : site non pris en charge, Cloakly n'y analyse rien."}
          </p>
        )}
      </div>

      <dl className="stats">
        <Stat label="Analysés" value={stats.analyzed} />
        <Stat label="Protégés" value={stats.protected} />
        <Stat label="Données masquées" value={stats.masked} />
        <Stat label="Bloqués" value={stats.blocked} />
      </dl>
      {stats.analyzed > 0 && (
        <button type="button" className="link-button" onClick={props.onResetStats}>
          Remettre les compteurs à zéro
        </button>
      )}

      <h2 className="section-title">Données à surveiller</h2>
      <div className="category-list">
        {categoryOptions.map((category) => {
          const needsAi = category.ai && !category.aiOptional && !settings.ai[category.ai];
          return (
            <label className={`category${needsAi ? " category-muted" : ""}`} key={category.id}>
              <input
                type="checkbox"
                checked={category.locked || settings.categories.includes(category.id)}
                disabled={category.locked}
                onChange={() => toggleCategory(category.id)}
              />
              <span className="checkbox-custom" aria-hidden="true" />
              <span className="category-copy">
                <strong>
                  {category.label}
                  {category.ai && <span className="pill">IA</span>}
                </strong>
                <small>{needsAi ? "Activez le modèle dans l'onglet « IA locale »." : category.detail}</small>
              </span>
            </label>
          );
        })}
      </div>

      <h2 className="section-title">Termes confidentiels</h2>
      <p className="section-description">Noms de clients, de projets ou de personnes à toujours masquer. Stockés sur cet appareil uniquement.</p>
      <form className="term-form" onSubmit={addTerm}>
        <input
          type="text"
          value={newTerm}
          onChange={(event) => setNewTerm(event.target.value)}
          placeholder="Ex. : Projet Atlas"
          aria-label="Nouveau terme confidentiel"
          maxLength={100}
        />
        <button type="submit" disabled={newTerm.trim().length < 2}>
          Ajouter
        </button>
      </form>
      {settings.customTerms.length > 0 && (
        <ul className="term-list">
          {settings.customTerms.map((term) => (
            <li key={term}>
              <span>{term}</span>
              <button
                type="button"
                aria-label={`Retirer ${term}`}
                onClick={() => update({ customTerms: settings.customTerms.filter((item) => item !== term) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {settings.customTerms.length > 0 && !settings.categories.includes("confidential") && (
        <p className="hint">La catégorie « Termes confidentiels » est décochée : ces termes ne sont pas masqués.</p>
      )}

      <div className="card strict-card">
        <div>
          <h2>Apprentissage</h2>
          <p>
            Une donnée décochée deux fois dans la revue sera ensuite proposée décochée. Une donnée cochée deux fois devient un terme
            confidentiel. Les secrets ne sont jamais concernés. Tout reste sur cet appareil.
          </p>
        </div>
        <Switch checked={settings.learning} label="Apprendre de mes corrections" onChange={(learning) => update({ learning })} />
      </div>
      {settings.allowTerms.length > 0 && (
        <>
          <p className="section-description">
            Proposées décochées{settings.privacyLevel === "maximum" ? " (ignoré en niveau maximal)" : ""} :
          </p>
          <ul className="term-list">
            {settings.allowTerms.map((term) => (
              <li key={term}>
                <span>{term}</span>
                <button
                  type="button"
                  aria-label={`Oublier ${term}`}
                  onClick={() => update({ allowTerms: settings.allowTerms.filter((item) => item !== term) })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="link-button" onClick={() => void resetLearning(settings).then((next) => update(next))}>
            Tout oublier
          </button>
        </>
      )}

      <div className="card strict-card">
        <div>
          <h2>Mode strict</h2>
          <p>Bloque l'envoi si la protection ne peut pas être vérifiée. Les données repérées par les règles ne peuvent pas être décochées.</p>
        </div>
        <Switch checked={settings.strictMode} label="Activer le mode strict" onChange={(strictMode) => update({ strictMode })} />
      </div>

      <div className="card strict-card">
        <div>
          <h2>Niveau de confidentialité</h2>
          <p>
            {settings.privacyLevel === "maximum"
              ? "Maximal : masque aussi les n° de commande ou de ticket, les IP privées et les personnalités publiques."
              : "Équilibré : masque les identifiants personnels et garde ce qui sert la demande (n° de commande, codes d'erreur…)."}
          </p>
        </div>
        <select
          aria-label="Niveau de confidentialité"
          value={settings.privacyLevel}
          onChange={(event) => update({ privacyLevel: event.target.value === "maximum" ? "maximum" : "balanced" })}
        >
          <option value="balanced">Équilibré</option>
          <option value="maximum">Maximal</option>
        </select>
      </div>
    </>
  );
}

function AiTab(props: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  status: AiStatus;
  onToggle: (kind: ModelKind, enabled: boolean) => void;
}) {
  const { settings, status } = props;

  return (
    <>
      <p className="section-description">
        Deux petits modèles d'IA tournent dans votre navigateur pour repérer ce que les règles ne voient
        pas. Ils sont téléchargés une seule fois, puis fonctionnent hors ligne.
      </p>

      {!isExtensionContext() && (
        <p className="hint">Aperçu hors extension : l'IA locale n'est disponible qu'une fois l'extension installée.</p>
      )}

      <ModelCard
        kind="ner"
        title="Noms, organisations et lieux"
        description="Modèle NER multilingue : repère « Sophie Lambert », « Biocoop »… en quelques dizaines de millisecondes."
        enabled={settings.ai.ner}
        state={status.ner}
        onToggle={(value) => props.onToggle("ner", value)}
      >
        {settings.ai.ner && (
          <label className="inline-check">
            <input
              type="checkbox"
              checked={settings.ai.locations}
              onChange={(event) => props.update({ ai: { ...settings.ai, locations: event.target.checked } })}
            />
            Masquer aussi les lieux (villes, pays…)
          </label>
        )}
      </ModelCard>

      <ModelCard
        kind="llm"
        title="Analyse du contexte"
        description="Mini-LLM : lit les messages longs et signale ce qui est confidentiel par le sens (fusion non annoncée, salaire, santé…)."
        enabled={settings.ai.llm}
        state={status.llm}
        onToggle={(value) => props.onToggle("llm", value)}
      >
        {status.webgpu === false && (
          <p className="hint">
            WebGPU indisponible sur cette machine : l'analyse tournera sur le processeur et peut prendre
            plusieurs secondes par message.
          </p>
        )}
      </ModelCard>

      <p className="fine-print">
        Les modèles peuvent se tromper : ils complètent les règles, ils ne les remplacent pas. Vous validez
        toujours le message avant l'envoi.
      </p>
    </>
  );
}

function ModelCard(props: {
  kind: ModelKind;
  title: string;
  description: string;
  enabled: boolean;
  state: ModelState;
  onToggle: (value: boolean) => void;
  children?: ReactNode;
}) {
  const model = MODELS[props.kind];
  const { state } = props;

  return (
    <div className="card model-card">
      <div className="section-heading">
        <div>
          <h2>{props.title}</h2>
          <p>
            {model.id.split("/")[1]} · ~{model.sizeMb} Mo
          </p>
        </div>
        <Switch
          checked={props.enabled}
          label={`Activer : ${props.title} (téléchargement d'environ ${model.sizeMb} Mo)`}
          onChange={props.onToggle}
        />
      </div>
      <p className="model-description">{props.description}</p>
      {props.enabled && (
        <div className="model-state" role="status">
          {state.state === "idle" && <span>Sera chargé au prochain message sur un site pris en charge.</span>}
          {state.state === "loading" && (
            <>
              <span>{state.progress === null ? "Préparation du modèle…" : `Téléchargement / chargement : ${state.progress} %`}</span>
              <progress max={100} value={state.progress ?? undefined} aria-label="Progression du chargement" />
            </>
          )}
          {state.state === "ready" && (
            <span className="ok">✓ Prêt ({state.device === "webgpu" ? "accéléré par WebGPU" : "processeur"})</span>
          )}
          {state.state === "error" && <span className="ko">Erreur : {state.error}</span>}
        </div>
      )}
      {props.children}
    </div>
  );
}

type TestResult = {
  sanitized: string;
  entities: SensitiveEntity[];
  kept: SensitiveEntity[];
  verdict: ContextVerdict | null;
  aiError: string | null;
  durationMs: number;
};

function TestTab({ settings }: { settings: Settings }) {
  const [sample, setSample] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [running, setRunning] = useState(false);

  const kinds = useMemo(
    () => ({
      ner: settings.ai.ner && settings.categories.includes("identities") && isExtensionContext(),
      llm:
        settings.ai.llm &&
        settings.categories.includes("context") &&
        isExtensionContext() &&
        needsContextAnalysis(sample),
    }),
    [settings, sample]
  );

  async function run(event: FormEvent) {
    event.preventDefault();
    if (!sample.trim()) return;
    setRunning(true);
    const start = performance.now();
    let findings: AiFindings | null = null;
    let aiError: string | null = null;

    if (kinds.ner || kinds.llm) {
      try {
        findings = await analyzeWithAi(sample, kinds, 120_000);
        if (!settings.ai.locations && findings.ner) {
          findings.ner = findings.ner.filter((entity) => entity.type !== "LOCATION");
        }
      } catch (error) {
        aiError = error instanceof Error ? error.message : String(error);
      }
    }

    const analysis = analyzeMessage(
      sample,
      {
        categories: settings.categories,
        customTerms: settings.customTerms,
        level: settings.privacyLevel,
        allowTerms: settings.learning ? settings.allowTerms : [],
      },
      findings
    );
    const entities = expandOccurrences(sample, analysis.entities);
    setResult({
      sanitized: anonymizeText(sample, entities, createAliasRegistry()).text,
      entities,
      kept: analysis.kept,
      verdict: findings?.verdict ?? null,
      aiError,
      durationMs: Math.round(performance.now() - start),
    });
    setRunning(false);
  }

  const engines = ["règles", kinds.ner && "NER", kinds.llm && "LLM"].filter(Boolean).join(" + ");

  return (
    <form className="tester" onSubmit={run}>
      <p className="section-description">Collez un texte pour voir ce que Cloakly remplacerait. Rien n'est envoyé.</p>
      <textarea
        value={sample}
        onChange={(event) => setSample(event.target.value)}
        placeholder="Ex. : Merci de ne pas ébruiter le rachat de Biocoop par Danone, Sophie Lambert valide le 15 mars."
        aria-label="Texte à tester"
        rows={5}
      />
      <div className="tester-actions">
        <small>Moteurs : {engines}</small>
        <button type="submit" disabled={running || !sample.trim()}>
          {running ? "Analyse…" : "Analyser"}
        </button>
      </div>

      {result && (
        <div className="tester-result" aria-live="polite">
          {result.aiError && <p className="ko">IA indisponible ({result.aiError}) : résultat des règles seules.</p>}
          {result.verdict && result.verdict.risk !== "none" && (
            <p className={`verdict verdict-${result.verdict.risk}`}>
              <strong>Risque {({ low: "faible", medium: "modéré", high: "élevé" } as const)[result.verdict.risk]}</strong>
              {result.verdict.reason && ` : ${result.verdict.reason}`}
            </p>
          )}
          {result.entities.length === 0 ? (
            <p>Aucune donnée sensible détectée ({result.durationMs} ms).</p>
          ) : (
            <>
              <p>
                {result.entities.length} élément(s) en {result.durationMs} ms :{" "}
                {[...new Set(result.entities.map((item) => ENTITY_LABELS[item.type]))].join(", ")}
              </p>
              <pre>{result.sanitized}</pre>
            </>
          )}
          {result.kept.length > 0 && (
            <p>
              Conservé car utile à la demande :{" "}
              {result.kept.map((item) => `${item.value} (${item.reason ?? ENTITY_LABELS[item.type]})`).join(", ")}
            </p>
          )}
        </div>
      )}
    </form>
  );
}

function Header({ active, theme, onToggleTheme }: { active?: boolean; theme?: Theme; onToggleTheme?: () => void }) {
  return (
    <header className="header">
      <div className="logo" aria-hidden="true">
        C
      </div>
      <div>
        <h1>Cloakly</h1>
        <p className="subtitle">Vos données restent les vôtres, même face à l'IA</p>
      </div>
      <div className="header-actions">
        {active !== undefined && (
          <span className={`header-pill ${active ? "on" : "off"}`}>{active ? "Actif" : "En pause"}</span>
        )}
        {theme && onToggleTheme && (
          <button
            type="button"
            className="theme-toggle"
            aria-label={theme === "dark" ? "Passer en mode clair" : "Passer en mode sombre"}
            aria-pressed={theme === "dark"}
            title={theme === "dark" ? "Mode clair" : "Mode sombre"}
            onClick={onToggleTheme}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        )}
      </div>
    </header>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Switch(props: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className={`switch ${props.checked ? "switch-on" : ""}`}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export default App;
