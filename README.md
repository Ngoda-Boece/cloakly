# Cloakly

Extension Chrome (Manifest V3) qui repère et pseudonymise vos données confidentielles **avant** leur
envoi à un assistant IA (ChatGPT, Claude, Gemini, Le Chat). Tout se passe dans votre navigateur :
des règles déterministes, plus deux petits modèles d'IA qui tournent en local.

> Anciennement « Shield AI ».

## Ce que fait Cloakly

1. Sur un site pris en charge, Cloakly intercepte l'envoi (touche Entrée, bouton d'envoi, soumission de formulaire).
2. Le message est analysé localement en trois couches :
   - **Règles contextuelles** : e-mails, téléphones, adresses postales, dates de naissance, noms de personnes
     (civilité, « je m'appelle », lien de parenté, champ « Nom : », signature, prénom + nom), IBAN, cartes,
     n° de sécurité sociale, passeport, n° client ou de dossier, IP publiques, URL internes, clés d'API, jetons,
     clés privées, mots de passe, vos termes confidentiels. Chaque candidat reçoit une **décision**
     (masquer / conserver), un **score de confiance** et un **motif** (voir « Moteur de décision »).
   - **IA · NER** (optionnel, ~135 Mo) : personnes, organisations, lieux. Environ 0,1 s par message sur processeur.
   - **IA · contexte** (optionnel, ~760 Mo) : un mini-LLM lit les messages longs et cite les passages confidentiels par leur sens (rachat non annoncé, salaire, santé, chiffres non publiés…).
3. Si rien n'est à masquer, le message part normalement. Sinon, une fenêtre montre chaque donnée (avec sa source :
   règle, déjà masqué, NER ou contexte), son marqueur (`[PERSONNE_1]`, `[EMAIL_1]`…), la demande reconnue, le verdict
   de l'IA et le message exact qui sera envoyé. Les éléments **conservés car utiles** (n° de commande, IP privée…)
   y figurent décochés, avec leur motif : on peut choisir de les masquer. Un avertissement apparaît si la sélection
   masquerait un paramètre ou la consigne de la demande.
4. Après confirmation, une **validation indépendante** relit le résultat (voir plus bas), la zone de saisie est
   réécrite, **relue et revérifiée**, puis le message est envoyé. « Message protégé » ne s'affiche que si ces
   vérifications ont réussi.
5. Un bouton « Cloakly · N alias » en bas à gauche affiche la table de correspondance de l'onglet et
   **restaure les vraies valeurs** dans une réponse de l'IA collée dans le panneau.

Une même valeur reçoit toujours le même alias pendant la session du navigateur (pseudonymisation cohérente,
y compris après rechargement de la page). Une valeur déjà masquée l'est aussi dans les messages suivants, même sans
indice (« Martin » après « Jeanne Martin »). Les alias sont effacés à la fermeture du navigateur, ou à la demande
(« Effacer les correspondances » dans le panneau).

### Mode strict (activé par défaut)

- Si l'analyse échoue, si la zone de saisie est introuvable ou si le remplacement ne peut pas être vérifié, l'envoi est bloqué.
- Les données au **format vérifié** avec une confiance forte (e-mail, téléphone, IBAN, carte, NIR, passeport, adresse,
  IP publique, terme confidentiel) ne peuvent pas être décochées. Les noms repérés par les règles et les détections
  de l'**IA** peuvent l'être, car un indice ou un modèle peut se tromper (ex. « Napoléon »).
- Les **secrets** (clés, jetons, mots de passe) ne sont jamais décochables, même hors mode strict, et sont analysés
  même si leur catégorie est décochée.
- Si l'IA est indisponible, l'utilisateur peut relancer l'analyse avec les règles seules, mais jamais envoyer sans analyse.

Hors mode strict, « Envoyer sans protéger » est proposé, avec un avertissement explicite.

## Moteur de décision

Principe : **minimiser les données personnelles exposées, pas les informations utiles à la tâche.**

| Catégorie                       | Exemples                                                                                      | Traitement par défaut (niveau « équilibré »)                      |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Identifiants directs             | nom, e-mail, téléphone, adresse, NIR, passeport, IBAN, carte, n° client/dossier            | masqués                                                               |
| Données à risque élevé       | secrets, données d'un enfant, identifiants dans un contexte de santé                        | masqués ; un secret n'est jamais transmis                             |
| Informations utiles à la tâche | montants, dates, heures, durées, compétences, codes d'erreur, versions, modèles d'appareil | conservées                                                            |
| Identifiants métier             | n° de commande, ticket, facture, suivi de colis, IP privée                                  | conservés et listés dans la revue (masqués en niveau « maximal ») |

- **Le contexte décide** (`src/engine/context.ts`) : `0612345678` est un téléphone après « appelle-moi au » et une
  référence après « commande n° » ; une suite de 13 chiffres n'est un NIR qu'avec un libellé ou une clé valide ;
  un numéro n'est une carte que s'il passe Luhn **et** commence par le préfixe d'un réseau (Visa, Mastercard…).
- **Validation structurelle** : clé IBAN (mod 97), clé NIR, Luhn, plages IP, préfixes de cartes et de clés d'API.
- **Contexte sensible** (santé, enfants, justice…) : les identifiants sont retirés, l'information utile à la demande
  (symptômes, posologie) est conservée.
- **Préservation de la tâche** (`src/engine/task.ts`) : verbe d'action, type de demande et paramètres sont repérés.
  Un extrait signalé par l'IA de contexte ne peut pas avaler un montant dans une demande de calcul.
- **Généralisation** plutôt que suppression quand c'est possible : dans une adresse, seule la voie est masquée,
  le code postal et la ville restent.
- **Marqueurs** typés, en français, qui ne révèlent rien de la valeur : `[PERSONNE_1]`, `[TELEPHONE_1]`,
  `[ADRESSE_1]`, `[IDENTIFIANT_ADMINISTRATIF_1]`, `[IDENTIFIANT_DOSSIER_1]`, `[REFERENCE_1]`, `[SECRET_1]`,
  `[INFORMATION_SENSIBLE_1]`… Une civilité reste hors du marqueur (« Mme [PERSONNE_1] ») pour garder l'accord. Un
  marqueur déjà présent dans le texte n'est jamais réattribué. « Dupont » seul reçoit le marqueur de « Jeanne Dupont »
  sauf ambiguïté.

### Validation indépendante avant envoi

`validateTransformation` (`src/engine/protect.ts`) relance ses propres contrôles sur le texte produit :

| Contrôle                                                                                                           | Effet                                                                             |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Aucun secret (contrôle inconditionnel)                                                                             | bloquant                                                                          |
| Aucune donnée à protéger restante, aucune valeur masquée encore présente (y compris à côté de son marqueur) | bloquant, après une seconde passe qui ne fait qu'**ajouter** des masquages |
| Texte identique à l'original hors des passages remplacés (espaces, accents, ponctuation)                          | bloquant                                                                          |
| Un marqueur = une seule valeur ; pas de collision avec un marqueur déjà présent                                  | bloquant                                                                          |
| Consigne, paramètres utiles, message réduit à des marqueurs                                                      | avertissement dans la revue                                                       |

Les messages d'erreur ne citent jamais la donnée. Les valeurs d'origine ne sont jamais restaurées pour faire
passer la validation.

### Mesures

`npm run eval:privacy` mesure, sur un jeu synthétique annoté (`src/engine/eval/`), la précision, le rappel, les faux
positifs et négatifs, la conservation de l'intention et des paramètres, les messages rendus incompréhensibles, la
latence et les fuites, par groupe de risque et par catégorie. `-- --set holdout` utilise un jeu de contrôle rédigé
après la mise au point et jamais utilisé pour régler le moteur ; `-- --engine <dossier>` compare une autre version.
Les objectifs (zéro fuite, zéro secret transmis, intention conservée) sont vérifiés par `npm test`.

Résultats (règles seules, niveau équilibré, v1.1 contre v1.0) :

|                                               | Référence v1.0 | Référence v1.1 | Contrôle v1.0 | Contrôle v1.1 |
| --------------------------------------------- | ---------------- | ---------------- | -------------- | -------------- |
| Messages                                      | 71               | 71               | 26             | 26             |
| Rappel                                        | 40,0 %           | 100 %            | 30,0 %         | 100 %          |
| Précision                                    | 86,7 %           | 100 %            | 100 %          | 95,5 %         |
| Données annotées transmises                 | 39               | 0                | 14             | 0              |
| dont secrets                                  | 4                | 0                | 1              | 0              |
| Messages sans donnée modifiés               | 16,7 %           | 0 %              | 0 %            | 12,5 %         |
| Intention conservée                          | 100 %            | 100 %            | 100 %          | 100 %          |
| Paramètres utiles conservés                 | 96,3 %           | 100 %            | 100 %          | 97,6 %         |
| Latence médiane / p95 (Node, machine de dev) | 0,02 / 0,09 ms   | 1,7 / 7,3 ms     | 0,02 / 0,20 ms | 1,6 / 5,8 ms   |

Ces chiffres valent pour ces jeux synthétiques, rédigés par l'auteur du moteur : le jeu de référence a servi à la mise
au point, le score de 100 % y est donc optimiste. Ils ne prouvent pas la sécurité sur des messages réels.

### Limites connues et risques résiduels

- **Le site voit ce que vous tapez.** Cloakly réécrit la zone de saisie juste avant l'envoi, mais le script du
  fournisseur peut lire cette zone pendant la frappe (brouillons, télémétrie de saisie). Seul l'envoi intercepté
  (Entrée, bouton, formulaire) est protégé ; un envoi par un autre moyen (dictée, pièce jointe, glisser-déposer,
  raccourci propre au site) ne l'est pas. Une protection complète demanderait une zone de saisie propre à Cloakly.
- **Réidentification par recoupement** : ce qui reste visible (ville, métier, employeur, dates, contexte médical) peut
  suffire à reconnaître quelqu'un. Les organisations et lieux ne sont repérés qu'avec le modèle NER.
- **Noms** : sans NER, un nom sans indice (ni civilité, ni présentation, ni prénom connu) passe. Une personnalité
  publique peut être masquée à tort (« Quel rôle a joué Marie Curie ? ») : la case est alors décochable.
- **Secrets** : seuls les formats connus et les secrets annoncés par un libellé sont repérés ; une clé
  sans préfixe ni libellé n'est pas reconnue.
- Les sélecteurs des sites changent souvent ; un sélecteur cassé rend l'interception inopérante sur ce site.
- La table de correspondance (valeurs d'origine) reste en mémoire (`storage.session`) jusqu'à la fermeture du
  navigateur ou à l'effacement manuel.

## L'IA locale

| Modèle                                                                                                                               | Rôle                                  | Téléchargement | Exécution                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------- | ----------------------------------------------------------- |
| [`Xenova/distilbert-base-multilingual-cased-ner-hrl`](https://huggingface.co/Xenova/distilbert-base-multilingual-cased-ner-hrl) (q8) | Personnes, organisations, lieux        | ~135 Mo          | WASM (processeur), ~20–100 ms                              |
| [`onnx-community/gemma-3-1b-it-ONNX`](https://huggingface.co/onnx-community/gemma-3-1b-it-ONNX) (q4f16)                              | Passages confidentiels par le contexte | ~760 Mo          | WebGPU si disponible, sinon processeur (plusieurs secondes) |

- Les modèles sont **désactivés par défaut** : il faut les activer dans l'onglet « IA locale » du popup, qui affiche la progression du téléchargement.
- Ils sont téléchargés **une seule fois** depuis Hugging Face, puis gardés dans le cache du navigateur. **Le contenu de vos messages n'est jamais envoyé** : seuls les fichiers des modèles sont téléchargés.
- Ils tournent dans un [document offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen) via [transformers.js](https://github.com/huggingface/transformers.js). Le moteur ONNX Runtime (WASM) est embarqué dans l'extension, car MV3 interdit le code distant.
- Le LLM n'est consulté que pour les messages d'au moins 40 caractères et 6 mots.

### Pourquoi ces modèles (évaluation)

`npm run eval:ai` exécute les modèles sous Node sur des messages français types. Résultats avec le prompt
et l'analyseur de Cloakly :

| Message                    | Qwen2.5-0.5B | Qwen3-0.6B                           | LFM2-700M              | **Gemma-3-1B (retenu)**          |
| -------------------------- | ------------ | ------------------------------------ | ---------------------- | -------------------------------------- |
| Rachat non annoncé        | raté        | phrases entières (consigne incluse) | raté                  | « rachat de Biocoop », « 15 mars » |
| Salaire + arrêt maladie   | partiel      | ✓                                   | raté                  | ✓                                     |
| Question TCP/UDP           | faux positif | ✓                                   | répond à la question | ✓                                     |
| Poème sur Paris           | faux positif | ✓                                   | faux positif           | ✓                                     |
| CA non publié + fermeture | raté        | ✓                                   | partiel                | ✓ (précis)                           |
| Napoléon à Waterloo      | faux positif | ✓                                   | faux positif           | ✓                                     |

**Garde-fous contre les erreurs du LLM :**

- Un extrait qui ne figure pas **mot pour mot** dans le message est rejeté (les petits modèles inventent).
- Un extrait qui couvre presque tout le message est rejeté.
- Un verdict « risqué » sans extrait vérifiable n'interrompt pas l'utilisateur.
- Les extraits sont découpés autour des détections plus fiables : un extrait IA n'avale jamais un e-mail trouvé par les règles.

**Limites connues :** ces modèles restent petits. Ils ratent des cas, en signalent d'autres à tort, et le LLM
est lent sans WebGPU. Ils complètent les règles sans les remplacer, et l'utilisateur valide toujours.

## Sites pris en charge

ChatGPT (`chatgpt.com`, `chat.openai.com`), Claude (`claude.ai`), Gemini (`gemini.google.com`),
Le Chat (`chat.mistral.ai`). Les sélecteurs sont dans [`src/shared/sites.ts`](src/shared/sites.ts). Ces
sites changent souvent leur interface : à vérifier régulièrement.

## Installation (mode développeur)

```bash
npm install
npm run build
```

Dans Chrome : `chrome://extensions` → **mode développeur** → **Charger l'extension non empaquetée** → dossier `dist/`.
Rechargez ensuite les onglets des sites d'IA déjà ouverts.

## Développement

| Commande                 | Rôle                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`          | serveur Vite : popup sur `/` (sans IA hors extension), chat simulé sur `/demo/`                                                  |
| `npm test`             | tests Vitest : moteur, IA (logique pure), réglages, intercepteur et comportement réseau simulé dans jsdom, objectifs de métriques |
| `npm run eval:privacy` | mesures de protection et de préservation de la tâche (`-- --set holdout`, `-- --level maximum`, `-- --engine <dossier>`)      |
| `npm run lint`         | Oxlint                                                                                                                                |
| `npm run build`        | TypeScript + build du popup, de l'offscreen, du service worker et du content script dans `dist/`                                    |
| `npm run eval:ai`      | évalue les modèles sur des messages types (`-- ner` ou `-- llm` pour n'en lancer qu'un)                                         |
| `npm run icons`        | régénère les icônes PNG                                                                                                           |

## Architecture

```
content script (page du site)          service worker              document offscreen
 ├─ intercepte l'envoi                  └─ relaie les messages ──▶  └─ transformers.js + ONNX Runtime
 ├─ règles (synchrones)                    et crée l'offscreen          ├─ NER (WASM)
 ├─ demande l'analyse IA ─────────────────────────────────────────▶    └─ mini-LLM (WebGPU / WASM)
 ├─ fusionne, affiche la revue, réécrit et vérifie
 └─ panneau d'alias / restauration
```

```
src/engine/       logique pure et testée : règles et contexte, noms et adresses, tâche, NER → positions, prompt et
                  analyse du LLM, fusion, pseudonymisation, validation indépendante
src/engine/eval/  jeux synthétiques annotés et calcul des métriques
src/ai/           protocole de messages, modèles retenus, runtime (offscreen) et client
src/background/   service worker (relais + création du document offscreen)
src/offscreen/    point d'entrée du document offscreen
src/content/      interception, éditeurs, fenêtres, panneau d'alias
src/shared/       réglages (chrome.storage.local), statistiques locales, sites pris en charge
public/manifest.json   les URL doivent correspondre à src/shared/sites.ts (vérifié par un test)
scripts/          évaluation des modèles, génération des icônes
demo/index.html   chat simulé pour les tests manuels
```

Stockage : réglages et statistiques dans `chrome.storage.local` (jamais synchronisés), alias dans
`chrome.storage.session` (effacé à la fermeture du navigateur), modèles dans le cache du navigateur.

Confidentialité des échanges internes : le texte ne sort jamais de l'extension (messages `chrome.runtime` vers le
document offscreen, aucun appel réseau avec le contenu). La revue et le panneau d'alias sont dans un Shadow DOM
**fermé** : le script du site ne peut pas y lire les valeurs d'origine ni la table de correspondance. Le content
script est injecté dès `document_start` et intercepte avant le chargement des alias de session. Aucun prompt n'est
journalisé.
