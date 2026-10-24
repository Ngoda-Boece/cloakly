---
description: Une itération de la boucle d'auto-amélioration du moteur Cloakly
---

Fais UNE itération d'amélioration du moteur de détection, en respectant les règles de `CLAUDE.md`.

1. **Préparer.** Vérifie que tu es sur la branche `auto-improve` et que `src/engine` n'a pas de modification non commitée (`git status --short src/engine`). Sinon, arrête-toi et signale-le.
2. **Mesurer.** Tire une graine au hasard (par ex. `node -e "console.log(Date.now() % 100000)"`) puis lance :
   `npm run eval:privacy -- --set generated --seed <graine> --count 160 --failures tmp/failures.json`
   Lance aussi deux autres graines si la première ne montre aucun écart.
3. **Choisir une seule famille d'écarts** dans `tmp/failures.json`, par ordre de gravité : secret transmis, puis fuite d'une donnée directe ou sensible, puis paramètre ou intention perdus, puis faux positif. À gravité égale, prends la plus fréquente.
4. **Figer le défaut.** Ajoute 1 à 3 cas représentatifs au jeu de référence `src/engine/eval/corpus.ts`, avec des valeurs et des formulations différentes des cas générés. Vérifie qu'ils échouent avec `npm run eval:privacy`.
5. **Corriger le moteur** (`src/engine/detect.ts`, `names.ts`, `context.ts`, `task.ts`…) par une règle générale, jamais par une valeur codée en dur. Ne touche ni à `holdout.ts`, ni au générateur, ni aux métriques pour faire passer un cas.
6. **Valider :** `npm test`, `npm run lint`, puis `npm run eval:gate`.
7. **Conclure.**
   - Si les trois passent, commite le corpus et le moteur avec `eval/history.jsonl` et `eval/baseline.json`. Le message de commit (en français) décrit la famille corrigée et reprend les lignes « + » de la porte qualité.
   - Sinon, essaie au plus deux autres corrections. Si ça échoue encore, annule les changements du moteur et du corpus (`git checkout -- src/engine`), garde la ligne « rejected » de `eval/history.jsonl`, et explique en une phrase ce qui bloque.
8. **Résumer** en 3 lignes : la famille traitée, la décision, les métriques avant et après.

$ARGUMENTS
