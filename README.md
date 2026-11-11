# Badgeuse du Labo

Application de pointage quotidien liée à Twitch.

- **Frontend** : site statique publié sur GitHub Pages.
- **Backend** : Cloudflare Worker.
- **Données** : Cloudflare D1 (comptes, historique et sessions).
- **Planning et affichage** : Google Sheets.
- **Fuseau horaire de référence** : `Europe/Paris`.

Un compte Twitch peut enregistrer un seul badge par journée planifiée. La grille Google Sheets affiche au maximum 14 jours ; l'historique complet reste dans D1.

## Structure

- `frontend/` : application statique.
- `backend/src/` : Worker, OAuth Twitch, D1 et Google Sheets.
- `backend/migrations/` : migrations SQL versionnées.
- `backend/wrangler.toml` : configuration Wrangler.

## Préparation

### 1. Twitch

Créer une application dans la console développeur Twitch.

Définir l'URL de redirection OAuth exactement comme la valeur `TWITCH_REDIRECT_URI` du Worker, par exemple :

`https://badgeuse-twitch.<compte>.workers.dev/auth/callback`

Renseigner le Client ID dans `backend/wrangler.toml` et enregistrer le Client Secret comme secret Cloudflare (voir plus bas).

Aucun scope Twitch supplémentaire n'est demandé : l'application ne fait que lire l'identité publique du compte connecté.

### 2. Google Sheets

Créer un classeur avec deux onglets nommés `BADGEUSE` et `CONFIG`.

Dans `BADGEUSE` :
- ligne 1 : titre libre, conservé par la synchronisation ;
- ligne 2 : en-têtes générés automatiquement ;
- ligne 3 et suivantes : comptes Twitch triés par login.

Dans `CONFIG` :
- `C2` : date de début ;
- `C3` : date de fin ;
- `C5` : `Europe/Paris` ;
- `A8:B21` : une ligne par date de la période, date en colonne A et booléen `TRUE` ou `FALSE` en colonne B.

La période doit contenir de 1 à 14 jours calendaires consécutifs. Les jours fermés restent dans la grille mais ne permettent pas de badge.

Créer un compte de service Google, activer l'API Google Sheets et partager le classeur avec l'adresse e-mail du compte de service en accès **Éditeur**. Conserver le JSON de la clé privée comme secret Cloudflare ; ne jamais le committer dans Git.

### 3. Cloudflare

Depuis le dossier `backend/` :

1. Créer la base D1 `badgeuse-twitch` avec Wrangler.
2. Créer un namespace KV pour `OAUTH_KV`.
3. Reporter les identifiants D1 et KV dans `wrangler.toml`.
4. Remplacer les valeurs indicatives de `FRONTEND_URL`, `TWITCH_REDIRECT_URI`, `TWITCH_CLIENT_ID` et `SPREADSHEET_ID`.
5. Appliquer les migrations :

```bash
npx wrangler d1 migrations apply badgeuse-twitch --remote
```

6. Ajouter les secrets :

```bash
npx wrangler secret put TWITCH_CLIENT_SECRET
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```

Pour `GOOGLE_SERVICE_ACCOUNT_JSON`, fournir le contenu JSON complet de la clé du compte de service.

7. Déployer le Worker :

```bash
npx wrangler deploy
```

Les secrets ne doivent jamais être placés dans `[vars]` ni dans le dépôt.

### 4. Frontend et GitHub Pages

Dans `frontend/app.js`, remplacer `CONFIG.API_URL` par l'URL HTTPS réelle du Worker.

Le workflow `.github/workflows/deploy-pages.yml` publie le contenu de `frontend/` sur GitHub Pages à chaque mise à jour de `main`. Dans les paramètres du dépôt, sélectionner **Settings → Pages → Build and deployment → Source: GitHub Actions**.

L'URL GitHub Pages obtenue doit correspondre à `FRONTEND_URL` dans `backend/wrangler.toml`. Après toute modification de cette URL, redéployer le Worker.

## Vérifications avant ouverture

- `GET /health` répond avec `status: ok`.
- Les migrations `0001`, `0002` et `0003` sont appliquées sur la base D1 distante.
- Le Worker possède les bindings `DB` et `OAUTH_KV`.
- Les variables et secrets Twitch et Google sont renseignés.
- Le compte de service a accès en écriture au classeur.
- L'URL de redirection Twitch correspond exactement à celle déclarée chez Twitch.
- Le frontend utilise la bonne URL du Worker.
- Le parcours de connexion, le badge, le refus d'un second badge le même jour et le changement de date ont été testés avec de vrais services.

## Sécurité et limites connues

- Les codes OAuth temporaires et les sessions sont stockés sous forme de hash dans D1.
- Les sessions navigateur sont conservées dans `sessionStorage` : fermer l'onglet termine la session côté navigateur.
- Les badges sont uniques par identifiant Twitch et date.
- La synchronisation complète de la grille est sérialisée par un verrou D1 temporaire.
- Une réservation restée `pending` plus de deux minutes peut être reprise lors d'une nouvelle tentative.
- Les tests de code ne remplacent pas un test d'intégration avec Twitch, Cloudflare et Google Sheets.

Ne pas ouvrir le service au public avant d'avoir terminé les vérifications d'intégration.
