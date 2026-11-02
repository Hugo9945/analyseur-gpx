"""Découpe le fichier DGFiP « parcelles des personnes morales » en un fichier par département.

À relancer une fois par an, quand la DGFiP publie un nouveau millésime :
    python3 -m venv .venv && .venv/bin/pip install duckdb
    .venv/bin/python outils/preparer_proprietaires.py [fichier.parquet ou URL]

Produit docs/data/pm/<dep>.json.gz, lu directement par la page :
    { n: [dénominations], g: [groupes], f: [formes], d: [droits], p: { idu: [[n,g,f,d], ...] } }
"""
import gzip
import json
import os
import sys

import duckdb

SRC = sys.argv[1] if len(sys.argv) > 1 else (
    "https://static.data.gouv.fr/resources/fichiers-des-locaux-et-des-parcelles-des-personnes-morales-"
    "version-unifiee/20251103-131324/parcelles-personnes-morales-latest.parquet"
)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data", "pm")

con = duckdb.connect()
if SRC.startswith("http"):
    con.execute("INSTALL httpfs; LOAD httpfs;")
# idu = identifiant de parcelle du cadastre IGN : insee + commune absorbée + section + numéro
con.execute(f"""CREATE TABLE pm AS SELECT DISTINCT departement AS dep,
    code_insee || coalesce(prefixe,'000') || lpad(section,2,'0') || lpad(numero_parcelle::varchar,4,'0') AS idu,
    denomination AS n, groupe_personne_libelle AS g, forme_juridique_abregee AS f, code_droit_libelle AS d
  FROM '{SRC}'""")

os.makedirs(OUT, exist_ok=True)
for (dep,) in con.execute("SELECT DISTINCT dep FROM pm ORDER BY 1").fetchall():
    tables = {k: {} for k in "ngfd"}
    parcels = {}
    for idu, *vals in con.execute("SELECT idu, n, g, f, d FROM pm WHERE dep = ? ORDER BY idu", [dep]).fetchall():
        row = [tables[k].setdefault(v, len(tables[k])) for k, v in zip("ngfd", vals)]
        parcels.setdefault(idu, []).append(row)
    doc = {k: list(t) for k, t in tables.items()}
    doc["p"] = parcels
    data = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
    with open(os.path.join(OUT, f"{dep}.json.gz"), "wb") as fh:
        fh.write(gzip.compress(data, 9))
    print(dep, len(parcels), "parcelles")
