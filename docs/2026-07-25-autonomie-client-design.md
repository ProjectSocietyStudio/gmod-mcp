# Autonomie du pilotage client — design

> Ce que le MCP doit gagner pour qu'un agent exerce le côté client **sans opérateur humain**.
> Cadré le 25/07/2026, à partir d'une session de test réelle dont chaque manque listé ici a
> coûté du temps mesurable. Contrat de l'outillage : `../README.md`.

---

## 1. Le constat, et pourquoi il est fiable

Une session de preuve en jeu du 25/07/2026 a exercé trois écrans neufs (inventaire `rStorage`,
création de personnage `rCharacters`, section d'attributs `rAttributs`). L'agent a pu **ouvrir les
écrans, cliquer, lire l'état serveur et la base** — mais **pas terminer une création de
personnage**, faute de pouvoir écrire deux mots dans deux champs de texte. La dernière case du
socle est restée ouverte pour cette seule raison.

Ce document ne liste donc pas des améliorations souhaitables en principe : chaque point est un
blocage **rencontré**, avec son coût.

## 2. Le principe qui tranche les priorités

**Un agent doit désigner ce qu'il manipule par son NOM, et asserter du TEXTE.**

Toute la session s'est faite en coordonnées de pixels calculées sur des captures JPEG
redimensionnées. Cliquer `(1568, 964)` parce qu'un bouton s'y trouvait sur une image d'il y a
trois secondes n'est pas du pilotage, c'est de la divination — et lire « Budget : 4 point(s)
restant(s) sur 6 » **dans une image** n'est pas une assertion. Un test qui ne peut pas se rejouer
après un changement de résolution n'est pas un test.

D'où l'ordre : ce qui remplace le pixel par un nom, et l'image par du texte, passe devant tout le
reste.

## 3. Lot 1 — ce qui rend le pilotage possible (prioritaire)

### 3.1 Saisir du texte dans un champ (**bloquant**)

`client_input action:"type"` rapporte `typed: N` puis `keyboard_focus: "Panel"` : un clic
synthétique ne donne pas le focus clavier à un `DTextEntry`, donc les caractères ne vont nulle
part. **Aucun formulaire n'est remplissable**, ce qui interdit la création de personnage, l'achat,
la recherche, tout écran à saisie.

Attendu : une action qui **cible un champ** (par nom, cf. 3.2) et y pose une valeur, en passant
par le chemin que le panel expose (`RequestFocus`, puis `SetText` **suivi de la notification de
changement** — un `SetText` muet laisserait la logique de validation dans l'état d'avant). La
frappe caractère par caractère reste utile pour exercer les gestionnaires de touche, mais ce n'est
pas le cas courant.

### 3.2 Désigner un panel par son nom, et connaître son rectangle

`inspect_panel` cherche par **classe**. Or les panels du kit `rUI` sont enregistrés sous des noms
(`R_UI_Button`, `R_UI_Card`, `R_CharCreate`) mais ont pour **classe** leur base VGUI (`Label`,
`Panel`) : `inspect_panel class:"R_UI_Button"` répond « no panel of class R_UI_Button » alors que
l'arbre en contient plusieurs.

Attendu : recherche par **nom**, avec le rectangle écran, et un clic qui accepte une **cible
nommée** plutôt que des coordonnées. Corollaire : pouvoir distinguer plusieurs occurrences (index,
ou filtre par texte contenu — « le bouton qui dit ÉCROUER »).

### 3.3 Lire le TEXTE de l'interface

Il n'existe aucun moyen de lire ce qu'un écran affiche autrement qu'en capturant une image. Toutes
les vérifications de la session (budget restant, valeur d'un attribut, coût d'un trait, titre d'une
fenêtre) ont été faites à l'œil sur du JPEG compressé.

Attendu : un vidage de l'arbre Derma **avec le contenu textuel** de chaque panel
(`GetText`/`GetValue` quand ils existent), pour que les assertions portent sur des chaînes. C'est
aussi deux ordres de grandeur moins cher qu'une capture : `capture_screen` transmet ses octets en
morceaux de 7 Ko **cadencés par frame**, et domine tout aller-retour.

La capture d'écran reste indispensable — pour ce qui est **visuel** (chevauchement, z-order,
glyphe manquant, contraste). Elle cesse simplement d'être le seul moyen de lire un nombre.

### 3.4 Un clic qui suffit à lui-même

Un `click` isolé échoue : le panel n'est pas encore survolé. Il faut `move_cursor`, **puis**
`click` aux mêmes coordonnées. Trois clics ont été perdus avant de comprendre.

Attendu : `click` déplace le curseur, laisse passer la frame de survol, puis presse et relâche.
Le mode d'emploi actuel est un piège pour quiconque n'a pas lu ce document.

## 4. Lot 2 — ce qui rend le diagnostic possible

### 4.1 Exécution Lua côté client (dev uniquement)

`run_lua` est **serveur uniquement**. Impossible d'inspecter `R.Attributs`, l'état d'une section,
ou de vérifier qu'un net message est bien arrivé côté client. Même garde que l'existant
`gmod_mcp_runlua` : addon séparé, monté en dev, jamais en production.

### 4.2 Vitalité du client

Le client a **gelé** pendant la session (des `ClientsideModel` créés depuis un `Paint`), et l'agent
a continué à émettre des appels qui expiraient à 30 s, en attribuant la panne au transport. Un
signal simple — FPS, horodatage de la dernière frame — aurait dit « le client ne rend plus »
immédiatement.

Attendu : cette information dans `health`, et un message d'erreur qui la cite quand une commande
client expire.

### 4.3 Lire ce que l'interface a répondu au joueur

Quand `/characters` n'a rien ouvert, il n'existait **aucun moyen** de savoir si le serveur avait
refusé, et pourquoi. Les refus passent par `R.UI.Notify`, invisible à l'agent. Même chose pour
toute erreur affichée à l'écran plutôt que journalisée.

Attendu : accès aux notifications récentes côté client.

## 5. La limite qu'aucun outil ne franchit

**GMod n'est pas installé sur la machine de développement.** Le client est le jeu de l'opérateur,
sur son écran. Un agent ne peut donc ni le lancer, ni le relancer après un gel, ni travailler en
son absence. Même avec les lots 1 et 2 complets, l'autonomie plafonne à **« tout sauf le premier
lancement et la récupération d'un crash »**.

Le seul dépassement possible est un **client dédié à l'agent** : GMod installé ici, lancé et arrêté
par le MCP, connecté en LAN. Ça débloque les boucles non surveillées, la reprise après crash, et
des tests de régression client rejouables. Ça coûte une installation d'une dizaine de Go, une
session graphique capable de rendre du Derma (donc un GPU ou un `Xvfb` avec rendu logiciel, à
vérifier), et un compte Steam disponible. **C'est une décision d'infrastructure, pas une
amélioration d'outil** — hors périmètre de ce document, qui note seulement qu'elle est le seul
chemin restant.

Et deux choses resteront humaines quoi qu'on fasse : **« est-ce que c'est beau »** et **« est-ce
que c'est fun »**. La porte de test du Jalon V (`../../ROADMAP.md` §5) est écrite en ces termes, et
c'est volontaire.

## 6. Ce qui n'est PAS dans ce périmètre

- Le **garde d'instance** du transport (deux daemons se détruisant leurs réponses) : déjà livré le
  25/07/2026, verrou `daemon.lock`.
- Les **garde-fous d'expiration** du relais client : déjà livrés, et **préventifs** — ils ne
  corrigeaient pas le blocage observé, qui venait du daemon en double.
- La **grille de modèles qui gèle le client** (`R_UI_Grid` instanciant des `ClientsideModel` depuis
  un `Paint`) : c'est un bug de `rUI`/`rCharacters`, pas du MCP. Il doit être corrigé de son côté,
  et il l'était déjà avant que ce document existe si la date des commits le dit.

## 7. Ordre de livraison

1. **Lot 1** (3.1 → 3.4). Petit, et il supprime l'essentiel de ce qui a coûté du temps. Après lui,
   un agent termine seul une création de personnage et **ferme la dernière case du socle**.
2. **Lot 2** (4.1 → 4.3). Rend les pannes lisibles au lieu de devinables.
3. **Client dédié** — seulement sur décision explicite, et pour des boucles non surveillées.

Chaque lot se prouve **en jeu, sur le client de l'opérateur**, jusqu'à ce qu'un client dédié
existe. Le `dist/` exécuté étant celui du démarrage de la session Claude Code, un correctif
TypeScript n'est **pas** prouvable dans la session qui l'écrit : le dire, ne pas le prétendre.
