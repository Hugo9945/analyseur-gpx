# Analyseur de traces GPX

Glisse une trace `.gpx`, obtiens :
- la répartition par type de voie (route revêtue, empierrée, chemin, sentier…) d'après la BD TOPO IGN ;
- le foncier traversé (non cadastré, personne publique, personne morale privée, particulier probable) d'après le cadastre IGN et le fichier DGFiP des parcelles des personnes morales ;
- la liste des passages à vérifier en terrain privé, et des exports CSV.

Tout tourne dans le navigateur : la trace n'est envoyée nulle part. Seules les données IGN (routes, cadastre, forêts publiques) sont chargées en direct depuis la Géoplateforme.

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
