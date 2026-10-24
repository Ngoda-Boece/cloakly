# Cloakly — consignes pour Claude

Extension Chrome (Vite + React + TypeScript) qui détecte et pseudonymise les données sensibles avant envoi à un site d'IA. Le moteur de détection est dans `src/engine/` ; il est autonome (aucun import hors de ce dossier).

## Commandes

- `npm test` — tests Vitest
- `npm run lint` — oxlint
- `npm run eval:privacy` — métriques sur le jeu de référence (`--set holdout|generated|all`, `--seed N`, `--failures fichier.json`, `--json`)
- `npm run eval:gate` — compare `src/engine` au moteur de `HEAD` ; sortie 0 seulement si au moins une métrique s'améliore sans aucune régression
- `npm run build` — extension dans `dist/`

## Règles non négociables

- **Sécurité d'abord :** ne jamais annoncer qu'un contenu est protégé si la protection n'a pas été vérifiée. Les secrets (`SECRET_TYPES`) ne sont jamais décochables. Une fuite ou un secret transmis compte toujours plus qu'un faux positif.
- **Jeu de contrôle (`src/engine/eval/holdout.ts`) :** ne jamais modifier le moteur pour faire passer un cas précis de ce fichier, et ne jamais le lire pour régler une règle. Pour corriger un défaut qu'il révèle, ajouter un cas équivalent (autres valeurs, autre formulation) au jeu de référence `corpus.ts`.
- **Pas de corrections au cas par cas :** une règle doit traiter la famille de cas, pas une valeur codée en dur tirée d'un cas généré.
- **Données synthétiques uniquement** dans les corpus, les tests et le générateur.
- Le code et les commentaires sont en français, dans le style des fichiers voisins.

## Boucle d'amélioration

`/improve` (`.claude/commands/improve.md`) lance une itération ; `/loop /improve` l'enchaîne. Elle travaille sur la branche `auto-improve`. L'historique des décisions est dans `eval/history.jsonl`, les dernières métriques acceptées dans `eval/baseline.json`.
