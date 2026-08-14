# Guide de mise en route — TRJV Enduro multi-épreuves

Ce guide explique comment tout fonctionne et comment mettre en place le nouveau système, étape par étape. Prévoyez de le faire calmement, sur ordinateur, **avant** le 12 septembre, avec un événement de test.

---

## 1. Les nouveaux concepts, en clair

| Notion | Explication |
|---|---|
| **Épreuve** | Une course indépendante (ex. "TRJV Enduro Lillebonne"). Chaque épreuve a ses propres pilotes, temps, classements, réglages. Rien n'est jamais partagé entre deux épreuves. |
| **Admin global** | C'est vous. Vous avez accès à **toutes** les épreuves, avec les mêmes droits que si vous étiez sur place, depuis n'importe où. |
| **Admin épreuve** | Une personne qui a les pleins pouvoirs, mais **uniquement sur une épreuve précise** (ex. l'organisateur de la course B). |
| **Opérateur** | Une personne qui peut uniquement pointer les départs/arrivées et consulter le classement sur l'épreuve à laquelle elle est rattachée. Elle ne peut pas supprimer un pilote, changer les réglages, ni gérer l'équipe. |
| **Compte** | Chaque personne (vous compris) se connecte désormais avec un **email + mot de passe**. Il n'y a plus d'accès "ouvert" à l'application. |

Techniquement, chaque épreuve vit dans sa propre "boîte" dans la base de données (`events/identifiant-epreuve/...`). Les règles de sécurité Firebase empêchent physiquement qu'un opérateur de la course A lise ou modifie quoi que ce soit dans la course B.

---

## 2. Configuration initiale (à faire UNE SEULE FOIS)

### Étape 2.1 — Activer l'authentification dans Firebase

1. Allez sur [console.firebase.google.com](https://console.firebase.google.com) et ouvrez votre projet `trjv-enduro-2026`.
2. Dans le menu de gauche : **Authentication** → **Get started** (si ce n'est pas déjà fait).
3. Onglet **Sign-in method** → activez **Email/Password** (Adresse e-mail/Mot de passe).

### Étape 2.2 — Créer votre compte administrateur global

1. Toujours dans **Authentication** → onglet **Users** → **Add user**.
2. Entrez votre email et un mot de passe (celui que vous utiliserez pour vous connecter à l'admin).
3. Cliquez sur **Add user**. Votre compte est créé, mais il n'est pas encore marqué comme "admin global" — ça se fera automatiquement à l'étape 2.4.

### Étape 2.3 — Mettre en place les règles de sécurité

1. Dans le menu de gauche : **Realtime Database** → onglet **Rules**.
2. Effacez tout le contenu et collez-y **l'intégralité** du fichier `database.rules.json` que je vous ai fourni.
3. Cliquez sur **Publier**.

> ⚠️ Tant que cette étape n'est pas faite, l'application ne pourra ni lire ni écrire de données (c'est normal et volontaire : c'est ce qui protège vos données).

### Étape 2.4 — Migrer vos données actuelles vers votre première épreuve

1. Mettez en ligne (sur votre hébergement, à côté des autres fichiers) le fichier `migration.html` que je vous ai fourni.
2. Ouvrez `migration.html` dans votre navigateur.
3. Connectez-vous avec l'email/mot de passe créés à l'étape 2.2. → vous devenez automatiquement **admin global**.
4. Donnez un identifiant à votre épreuve actuelle (ex. `lillebonne-2026`) et un nom affiché (ex. "TRJV Enduro Lillebonne").
5. Cliquez sur **Copier mes données actuelles vers cette épreuve**.
6. Le message de confirmation vous précise que vos anciennes données à la racine (`/riders`, `/timing`, etc.) n'ont **pas** été supprimées — elles restent en base comme filet de sécurité. Vous pourrez les effacer plus tard, une fois certain que tout fonctionne, directement dans la console (Realtime Database → sélectionner `riders`/`timing`/`config`/`history` à la racine → supprimer).
7. Vous pouvez ensuite supprimer `migration.html` de votre hébergement (il ne sert qu'une fois) — ou le laisser, il ne présente pas de risque particulier tant que vos identifiants restent secrets.

### Étape 2.5 — Mettre en ligne les fichiers de l'application

Remplacez sur votre hébergement les anciens fichiers par les nouveaux que je vous ai fournis :
- `index.html`
- `app.js`
- `firebase.js`
- `admin.css`
- `public.html`

(`classement.js`, `export.js`, `import.js`, `styles.css`, `notice.html` restent inchangés — inutile de les remplacer.)

---

## 3. Premier test

1. Ouvrez `index.html` dans un navigateur.
2. Vous arrivez sur l'écran de connexion → connectez-vous avec votre compte admin global.
3. Comme vous n'avez qu'une seule épreuve pour l'instant, l'application bascule automatiquement dessus (pas de sélecteur à ce stade).
4. Vérifiez que vos pilotes, temps et réglages sont bien là, identiques à avant.
5. Allez dans l'onglet **Épreuves & équipe** (visible uniquement pour vous, admin global) : vous devez y voir votre épreuve listée.

Si tout est là → la migration a fonctionné, vous pouvez continuer.

---

## 4. Créer la deuxième épreuve

1. Dans l'onglet **Épreuves & équipe**, formulaire "Créer une nouvelle épreuve" → entrez le nom (ex. "TRJV Enduro XXX") et la date → **Créer**.
2. L'application bascule automatiquement dessus. Vous repartez d'une épreuve vierge (aucun pilote, aucun temps) : configurez-la comme d'habitude (onglet **Course**, import Excel des pilotes, etc.).
3. Pour revenir à l'épreuve précédente à tout moment : bouton **Épreuve active** en haut de l'écran → cliquez sur l'épreuve voulue.

---

## 5. Ajouter les opérateurs sur place

Toujours dans **Épreuves & équipe**, section "Équipe de l'épreuve active" (assurez-vous d'avoir sélectionné la bonne épreuve avant) :

1. Renseignez l'email de la personne, un mot de passe initial (qu'elle pourra garder ou que vous lui communiquez), et son rôle :
   - **Opérateur** → pointage/chronométrage uniquement.
   - **Admin épreuve** → accès complet, mais seulement sur cette épreuve.
2. Cliquez sur **Ajouter**. Le compte est créé instantanément — la personne peut se connecter directement avec cet email/mot de passe sur `index.html`, elle arrivera automatiquement sur cette épreuve (elle n'a accès qu'à celle-ci, donc pas de sélecteur pour elle).
3. Pour retirer quelqu'un : bouton **Retirer** à côté de son nom dans la liste. Son compte continue d'exister mais n'a plus accès à cette épreuve.

Répétez pour chaque personne, sur chaque épreuve (une personne peut être opérateur sur les deux épreuves si besoin — recréez-la avec le même email sur l'autre épreuve... en pratique, si l'email existe déjà, l'app vous le signale ; dans ce cas, ajoutez-la manuellement via son UID existant en me demandant si besoin d'un raccourci).

---

## 6. Le lien du classement public

Chaque épreuve a son propre lien public, de la forme :

```
https://votre-domaine.fr/public.html?event=lillebonne-2026
```

L'identifiant (`lillebonne-2026`) est celui que vous avez choisi à la création de l'épreuve (visible dans l'onglet Épreuves & équipe si besoin). Donnez à chaque organisateur/club le lien correspondant à **sa** course.

---

## 7. Utilisation le jour de la course

- **Vous, depuis chez vous** : connectez-vous normalement, basculez entre les deux épreuves avec le bouton "Épreuve active" en haut de l'écran. Vous avez les pleins pouvoirs sur les deux, comme si vous étiez sur place.
- **Chaque opérateur, sur son site** : se connecte avec son propre compte, n'a accès qu'à sa course, ne peut pas se tromper d'épreuve par erreur (elle n'apparaît même pas chez lui).
- **Mode hors-ligne** : fonctionne comme avant. Le cache local est maintenant propre à chaque épreuve sur chaque appareil : pas de mélange même si un téléphone bascule d'une épreuve à l'autre.

---

## 8. Les deux correctifs mobile

- **Clavier qui ne s'ouvrait pas** : corrigé. Le champ de saisie du dossard ne devrait plus jamais rester "muet" au tap.
- **Navigation bloquée** : je n'ai pas trouvé de bug franc dans le code existant, mais j'ai renforcé le comportement (le fond de page ne bouge plus derrière le menu ouvert, ce qui est une cause fréquente de ce symptôme sur iPhone). **Testez sur votre téléphone en conditions réelles** : si ça bloque encore, dites-moi précisément quel modèle/navigateur et à quel moment exactement (bouton qui ne s'ouvre pas ? menu qui s'ouvre mais rien ne réagit au tap ?), pour que je cible la correction.

---

## 9. En cas de souci

| Symptôme | Cause probable | Solution |
|---|---|---|
| "Permission denied" / rien ne s'affiche | Les règles (étape 2.3) ne sont pas encore publiées | Vérifiez dans la console Firebase → Rules |
| Écran de connexion en boucle | Mauvais email/mot de passe | Réinitialisez depuis la console Firebase → Authentication → Users |
| Un opérateur voit un message d'erreur en pointant | Il a peut-être été retiré de l'épreuve par erreur | Onglet Épreuves & équipe → vérifier sa présence dans la liste |
| "Un compte existe déjà avec cet email" en ajoutant un opérateur | La personne a déjà un compte (autre épreuve) | Dites-le-moi, j'ajoute un raccourci pour rattacher un compte existant à une nouvelle épreuve sans le recréer |

N'hésitez pas à me solliciter à chaque étape si un point bloque — mieux vaut avancer prudemment que de tout faire le jour J.