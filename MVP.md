
# Cloakly (ex-Shield AI) — MVP Scope

## Product objective

Protect sensitive information before it is submitted to a supported AI website.

## P0 — Must have

- [x] One-click protection toggle
- [x] Local detection of supported sensitive data patterns
- [x] Consistent pseudonymization
- [x] Preview of the sanitized text
- [x] Explicit user confirmation before submission
- [x] Strict mode: block submission if protection cannot be verified
- [x] Automated tests for detection and sanitization

## P1 — Should have

- [x] Configurable detection categories
- [x] Clear alerts and cancellation flow
- [x] Privacy status and error reporting
- [x] Keyboard accessibility

## Out of scope for the first night

- Universal AI website compatibility
- Remote AI analysis
- User accounts and cloud synchronization
- Public Chrome Web Store release

## Security requirement

Never claim that content is protected unless the protection process has actually succeeded and been verified.

## v1.0 — Cloakly

- [x] Renommage Shield AI → Cloakly (nom, icônes, interface)
- [x] IA locale : NER multilingue (personnes, organisations, lieux) dans un document offscreen
- [x] IA locale : mini-LLM (Gemma-3-1B) pour les données confidentielles par le contexte, choisi après évaluation de 4 modèles
- [x] Garde-fous IA : extraits vérifiés mot pour mot, priorité des règles sur l'IA, repli « règles seules » si l'IA échoue
- [x] Revue détaillée : une case par donnée, source affichée, aperçu en direct, verdict de l'IA
- [x] Restauration des vraies valeurs dans les réponses de l'IA (panneau d'alias)
- [x] Alias cohérents sur toute la session du navigateur
- [x] Statistiques locales et popup à onglets (Protection, IA locale, Tester)

## v1.1 — Moteur de décision

- [x] Classification contextuelle (masquer / conserver, score, motif) : téléphone vs n° de commande, carte (Luhn + émetteur), NIR selon libellé
- [x] Noms, adresses (généralisées), dates de naissance, passeport, n° client/dossier sans modèle
- [x] Secrets étendus (Bearer, `.env`, JSON, PIN…), toujours analysés et jamais décochables
- [x] Préservation de la tâche : intention, paramètres, avertissements dans la revue
- [x] Marqueurs typés en français, anti-collision, coréférence des personnes, mémoire de session
- [x] Validation indépendante avant envoi, seconde passe sûre
- [x] Shadow DOM fermé, interception dès `document_start`, effacement des correspondances
- [x] Niveau de confidentialité (équilibré / maximal)
- [x] Jeux synthétiques, métriques (`npm run eval:privacy`), tests réseau simulés
