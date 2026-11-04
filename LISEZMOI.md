# Analyseur de traces GPX

Pensé pour la moto enduro et trail. Glisse une ou plusieurs traces `.gpx`, obtiens :
- l'accès moto : parcelles privées, accès réservés aux ayants droit (BD TOPO), interdictions OpenStreetMap (`motorcycle`, `motor_vehicle`, `access`, sentiers), sentiers non carrossables, zones protégées strictes ;
- la liste des points d'attention, cliquables sur la carte ;
- le profil d'altitude (RGE ALTI IGN) coloré par type de voie, et la répartition des pentes ;
- le type de voie (BD TOPO) et le revêtement (OpenStreetMap, sinon déduit de la BD TOPO) ;
- les zones réglementées traversées (cœurs de parcs nationaux, réserves, arrêtés de biotope, Natura 2000, PNR) ;
- le foncier traversé (cadastre IGN + fichier DGFiP des personnes morales) ;
- un tableau comparatif quand plusieurs traces sont chargées, et des exports CSV et GPX (trace ou section isolée) ;
- un générateur d'itinéraire de A à B ou en boucle depuis A avec une distance visée (`docs/route.js`) : plus court chemin (A*) sur le réseau BD TOPO en écartant sentiers, pistes cyclables, voies privées ou réservées et chemins des zones protégées strictes, en préférant nettement les chemins aux routes. Une boucle enchaîne des « secteurs de chemins » (morceaux d'un seul tenant du réseau de chemins autorisés) qu'elle traverse d'une route à une autre. Pendant le calcul, le cadastre des tronçons empruntés est vérifié et ceux qui traversent une parcelle privée sont écartés, jusqu'à stabilité (option « prudence » pour écarter aussi les limites de parcelle) ; la part de chemins publics observée dans le secteur sert à juger les chemins pas encore vérifiés. L'itinéraire est ensuite analysé ; les interdictions OpenStreetMap, connues plus tard, sont retenues pour les calculs suivants et s'affichent en rouge sans recalcul automatique (bouton « Éviter les points d'attention »). Le bouton « Chemins publics à … km de A » (rayon de 5 à 30 km) vérifie le cadastre de tous les chemins autour de A, du centre vers l'extérieur, et les dessine au fur et à mesure (publics en vert, privés en rouge) ; ils s'exportent en GPX pour tracer soi-même dans GPX Studio, et les verdicts servent ensuite au calcul.

Tout tourne dans le navigateur : la trace n'est envoyée nulle part. Les données IGN (Géoplateforme) et OpenStreetMap (Overpass) sont chargées en direct ; OpenStreetMap peut mettre une à deux minutes, ses résultats s'ajoutent alors automatiquement.

## Contenu

- `docs/` : l'application complète, à mettre en ligne telle quelle.
  - `docs/data/pm/` : propriétaires personnes morales, un fichier par département (≈ 77 Mo au total, seul le département traversé est chargé).
- `outils/preparer_proprietaires.py` : régénère `docs/data/pm/` quand la DGFiP publie un nouveau millésime (une fois par an).
- `exemples/Charny.gpx` : trace de test.

## Lancer en local

```bash
python3 -m http.server 8765 --directory docs
```

Puis ouvrir http://localhost:8765.

## En ligne

Le site est publié par GitHub Pages : https://hugo9945.github.io/analyseur-gpx/

Chaque `git push` sur `main` republie automatiquement le dossier `docs` (GitHub Pages, source : branche `main`, dossier `/docs`).

Sur iPad : Safari → Partager → « Sur l'écran d'accueil » pour l'avoir comme une app.

## Données

Le site ne conserve rien : pas de serveur, pas de compte, pas de cookie ni de stockage dans le navigateur.
La trace est lue et analysée dans le navigateur, puis disparaît avec « Effacer la trace » ou à la fermeture de la page.
Pour interroger l'IGN, les coordonnées de la trace sont envoyées par morceaux à la Géoplateforme (data.geopf.fr), comme le ferait Géoportail.
Les fichiers `.gpx` et le dossier `exemples/` sont exclus du dépôt (`.gitignore`).

## Mettre à jour les propriétaires

```bash
python3 -m venv .venv && .venv/bin/pip install duckdb
.venv/bin/python outils/preparer_proprietaires.py
```

Remplacer l'URL du fichier dans le script par celle du nouveau millésime sur data.gouv.fr (« Fichiers des locaux et des parcelles des personnes morales (version unifiée) »), puis `git push`.

## Publication

À chaque modification de `app.js`, `route.js` ou `style.css`, augmenter le numéro `?v=` de leur balise dans `docs/index.html` : sinon les navigateurs gardent jusqu'à 10 min (parfois plus) l'ancienne version en cache.

## Notice

La notice d'une page (`docs/notice.pdf`, bouton « Notice » du site) se régénère depuis `outils/notice.html` :

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer --print-to-pdf=docs/notice.pdf "file://$PWD/outils/notice.html"
```
