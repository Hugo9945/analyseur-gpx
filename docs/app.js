"use strict";

// ---------- Paramètres ----------
const WFS = "https://data.geopf.fr/wfs/ows";
const STEP = 10;          // m entre deux points d'échantillonnage
const ROAD_TOL = 15;      // m : distance max pour rattacher un point à un tronçon BD TOPO
const CHUNK = 120;        // sommets par requête WFS (limite la longueur d'URL)
const MIN_VERIF = 20;     // m : longueur min d'un passage à vérifier
const EDGE_TOL = 4;       // m : en deçà, un point privé est « en limite de parcelle » (décalage cadastre / BD TOPO)

const VOIE = [
  { key: "revetue",   label: "Route revêtue",      color: "--s1" },
  { key: "empierree", label: "Route empierrée",    color: "--s2" },
  { key: "chemin",    label: "Chemin",             color: "--s3" },
  { key: "sentier",   label: "Sentier / escalier", color: "--s4" },
  { key: "cyclable",  label: "Piste cyclable",     color: "--s5" },
  { key: "hors",      label: "Hors réseau IGN",    color: "--neutral" },
];
const FONC = [
  { key: "public",      label: "Personne publique (commune, État…)",   color: "--s1" },
  { key: "noncad",      label: "Non cadastré (voirie, domaine public)", color: "--s3" },
  { key: "limite",      label: "En limite de parcelle privée (±4 m)",  color: "--s5" },
  { key: "pmprivee",    label: "Personne morale privée (SCI, GFA…)",   color: "--s4" },
  { key: "particulier", label: "Particulier (probable)",               color: "--s8" },
  { key: "inconnu",     label: "Propriétaire inconnu",                 color: "--neutral" },
];
const PUBLIC_GROUPS = new Set([
  "commune", "État", "département", "région", "établissements publics ou organismes associés",
]);

function voieCat(nature) {
  switch (nature) {
    case undefined: case null: return "hors";
    case "Route empierrée": return "empierree";
    case "Chemin": return "chemin";
    case "Sentier": case "Escalier": return "sentier";
    case "Piste cyclable": return "cyclable";
    default: return "revetue";
  }
}

// ---------- Géométrie ----------
const R = 6371008.8, rad = Math.PI / 180;
function dist(a, b) {
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.hypot(x, y) * R;
}
// distance (m) d'un point p au segment [a,b] et point projeté q
function segDist(p, a, b) {
  const k = Math.cos(p[1] * rad);
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1], bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  return { d: Math.hypot(x, y) * rad * R, q: [p[0] + x / k, p[1] + y] };
}

class Grid {
  constructor(cell = 0.002) { this.c = cell; this.m = new Map(); }
  add([x0, y0, x1, y1], item) {
    const c = this.c;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++)
      for (let j = Math.floor(y0 / c); j <= Math.floor(y1 / c); j++) {
        const k = i + ":" + j;
        (this.m.get(k) || this.m.set(k, []).get(k)).push(item);
      }
  }
  at(x, y) { return this.m.get(Math.floor(x / this.c) + ":" + Math.floor(y / this.c)) || []; }
}

// ---------- GPX ----------
function parseGpx(text) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Fichier GPX illisible.");
  const pts = (nodes) => [...nodes].map((n) => {
    const e = n.getElementsByTagName("ele")[0];
    return [+n.getAttribute("lon"), +n.getAttribute("lat"), e ? +e.textContent : null];
  });
  const lines = [];
  for (const s of xml.getElementsByTagName("trkseg")) lines.push(pts(s.getElementsByTagName("trkpt")));
  for (const r of xml.getElementsByTagName("rte")) lines.push(pts(r.getElementsByTagName("rtept")));
  const ok = lines.filter((l) => l.length > 1);
  if (!ok.length) throw new Error("Aucune trace ni route dans ce fichier.");
  return ok;
}

function sample(lines) {
  const S = [];
  let at = 0;
  lines.forEach((l, li) => {
    for (let i = 1; i < l.length; i++) {
      const a = l[i - 1], b = l[i], d = dist(a, b);
      if (!d) continue;
      const n = Math.max(1, Math.ceil(d / STEP));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        S.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], len: d / n, at: at + d * t, line: li });
      }
      at += d;
    }
  });
  return { samples: S, total: at };
}

function elevation(lines) {
  let up = 0, down = 0;
  for (const l of lines) for (let i = 1; i < l.length; i++) {
    if (l[i][2] == null || l[i - 1][2] == null) continue;
    const d = l[i][2] - l[i - 1][2];
    if (d > 0) up += d; else down -= d;
  }
  return { up, down };
}

// ---------- Données IGN ----------
function chunks(lines) {
  const out = [];
  for (const l of lines) for (let i = 0; i < l.length - 1; i += CHUNK - 1) out.push(l.slice(i, i + CHUNK));
  return out;
}
const wkt = (c) => "LINESTRING(" + c.map((p) => `${p[1].toFixed(6)} ${p[0].toFixed(6)}`).join(",") + ")";

async function wfs(typename, cql) {
  const url = `${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&OUTPUTFORMAT=application/json` +
    `&SRSNAME=urn:ogc:def:crs:EPSG::4326&COUNT=5000&TYPENAMES=${typename}&CQL_FILTER=${encodeURIComponent(cql)}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`IGN ${r.status}`);
      return (await r.json()).features;
    } catch (e) {
      // 429 = quota Géoplateforme dépassé : on patiente et on réessaie
      if (attempt >= 5) throw e;
      await new Promise((ok) => setTimeout(ok, 1500 * 2 ** attempt));
    }
  }
}

async function pool(tasks, n, tick) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) { const j = i++; out[j] = await tasks[j](); tick(); }
  }));
  return out;
}

async function fetchLayers(lines, progress) {
  const cs = chunks(lines);
  const layers = {
    roads:   (w) => wfs("BDTOPO_V3:troncon_de_route", `DWITHIN(geometrie,${w},20,meters)`),
    parcels: (w) => wfs("CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle", `DWITHIN(geom,${w},8,meters)`),
    forests: (w) => wfs("BDTOPO_V3:foret_publique", `INTERSECTS(geometrie,${w})`),
  };
  const tasks = [];
  for (const [name, fn] of Object.entries(layers)) for (const c of cs) tasks.push(() => fn(wkt(c)).then((f) => [name, f]));
  let done = 0;
  const res = await pool(tasks, 3, () => progress(++done / tasks.length));
  const out = { roads: new Map(), parcels: new Map(), forests: new Map() };
  for (const [name, feats] of res) for (const f of feats) out[name].set(f.id, f);
  return { roads: [...out.roads.values()], parcels: [...out.parcels.values()], forests: [...out.forests.values()] };
}

// Propriétaires personnes morales (DGFiP), un fichier par département : data/pm/<dep>.json.gz
// { n: [dénominations], g: [groupes], f: [formes], d: [droits], p: { idu: [[n,g,f,d], ...] } }
const pmCache = new Map();
async function loadDept(dep) {
  if (!pmCache.has(dep)) pmCache.set(dep, (async () => {
    const r = await fetch(`data/pm/${dep}.json.gz`);
    if (r.status === 404) return { p: {} }; // département sans fichier
    if (!r.ok) throw new Error(`propriétaires ${dep} : ${r.status}`);
    let buf = new Uint8Array(await r.arrayBuffer());
    // certains hébergeurs décompressent déjà le .gz à la volée : on teste la signature gzip
    if (buf[0] === 0x1f && buf[1] === 0x8b)
      buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    return JSON.parse(new TextDecoder().decode(buf));
  })());
  return pmCache.get(dep);
}

async function fetchOwners(idus) {
  const deps = [...new Set(idus.map((i) => (i.startsWith("97") ? i.slice(0, 3) : i.slice(0, 2))))];
  const tables = Object.fromEntries(await Promise.all(deps.map(async (d) => [d, await loadDept(d)])));
  const out = {};
  for (const idu of idus) {
    const t = tables[idu.startsWith("97") ? idu.slice(0, 3) : idu.slice(0, 2)];
    const rows = t.p[idu];
    if (rows) out[idu] = rows.map(([n, g, f, d]) => ({ denomination: t.n[n], groupe: t.g[g], forme: t.f[f], droit: t.d[d] }));
  }
  return out;
}

// ---------- Analyse ----------
function lineParts(g) {
  return g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
}

function matchRoads(samples, roads) {
  const grid = new Grid();
  const pad = 0.0003;
  for (const f of roads) for (const part of lineParts(f.geometry)) for (let i = 1; i < part.length; i++) {
    const a = part[i - 1], b = part[i];
    grid.add([Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad], { f, a, b });
  }
  let prev = null;
  for (const s of samples) {
    const best = new Map(); // feature -> {d,q}
    for (const seg of grid.at(s.p[0], s.p[1])) {
      const r = segDist(s.p, seg.a, seg.b);
      // les ponts / tunnels passent après les tronçons au sol
      if (seg.f.properties.position_par_rapport_au_sol !== "0") r.d += 5;
      const cur = best.get(seg.f);
      if (!cur || r.d < cur.d) best.set(seg.f, r);
    }
    let pick = null;
    for (const [f, r] of best) if (r.d <= ROAD_TOL && (!pick || r.d < pick.r.d)) pick = { f, r };
    // hystérésis : on reste sur le tronçon précédent s'il est presque aussi proche (carrefours)
    if (pick && prev && pick.f !== prev && best.has(prev) && best.get(prev).d <= pick.r.d + 3) pick = { f: prev, r: best.get(prev) };
    s.road = pick ? pick.f : null;
    s.snap = pick ? pick.r.q : s.p;
    prev = s.road;
  }
}

function polyIndex(features) {
  const grid = new Grid(0.005);
  for (const f of features) { f.bbox = turf.bbox(f); grid.add(f.bbox, f); }
  return (p) => {
    for (const f of grid.at(p[0], p[1])) {
      const b = f.bbox;
      if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) continue;
      if (turf.booleanPointInPolygon(p, f)) return f;
    }
    return null;
  };
}

function boundaryDist(p, f) {
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  let d = Infinity;
  for (const poly of polys) for (const ring of poly) for (let i = 1; i < ring.length; i++) d = Math.min(d, segDist(p, ring[i - 1], ring[i]).d);
  return d;
}

function parcelCat(f, owners) {
  if (!owners) return "inconnu";
  const o = owners[f.properties.idu];
  if (!o) return "particulier";
  return o.some((x) => PUBLIC_GROUPS.has(x.groupe)) ? "public" : "pmprivee";
}

function foncCat(s, owners) {
  if (!s.parcel) return "noncad";
  const c = parcelCat(s.parcel, owners);
  return (c === "particulier" || c === "pmprivee") && boundaryDist(s.snap, s.parcel) < EDGE_TOL ? "limite" : c;
}

function sumBy(samples, keyFn) {
  const m = new Map();
  for (const s of samples) { const k = keyFn(s); m.set(k, (m.get(k) || 0) + s.len); }
  return m;
}

function verifRuns(samples, owners) {
  const runs = [];
  let cur = null;
  for (const s of samples) {
    const priv = s.fonc === "particulier" || s.fonc === "pmprivee";
    if (priv && cur && cur.line === s.line) {
      cur.samples.push(s);
    } else {
      if (cur) runs.push(cur);
      cur = priv ? { line: s.line, samples: [s] } : null;
    }
  }
  if (cur) runs.push(cur);
  return runs.map((r) => {
    const len = r.samples.reduce((a, s) => a + s.len, 0);
    const parcels = new Map();
    for (const s of r.samples) {
      const idu = s.parcel.properties.idu;
      parcels.set(idu, (parcels.get(idu) || 0) + s.len);
    }
    const natures = sumBy(r.samples, (s) => s.road ? s.road.properties.nature : "Hors réseau IGN");
    const nature = [...natures].sort((a, b) => b[1] - a[1])[0][0];
    const who = [...parcels.keys()].map((i) => owners && owners[i] ? owners[i].map((o) => o.denomination).join(", ") : "particulier").filter((v, i, a) => a.indexOf(v) === i);
    return { start: r.samples[0].at, len, parcels, nature, who, latlngs: r.samples.map((s) => [s.p[1], s.p[0]]) };
  }).filter((r) => r.len >= MIN_VERIF);
}

// ---------- Carte ----------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const map = L.map("map", { zoomControl: true }).setView([46.6, 2.5], 6);
const wmts = (layer, fmt = "image/png", style = "normal") => L.tileLayer(
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${encodeURIComponent(style)}` +
  `&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${fmt}`,
  { maxZoom: 20, maxNativeZoom: 19, attribution: "© IGN Géoplateforme" });
const plan = wmts("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2").addTo(map);
const ortho = wmts("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg");
const cadastre = wmts("CADASTRALPARCELS.PARCELLAIRE_EXPRESS", "image/png", "PCI vecteur");
L.control.layers({ "Plan IGN": plan, "Photo aérienne": ortho }, { "Cadastre": cadastre }, { position: "bottomright" }).addTo(map);

let layerVoie = L.layerGroup(), layerFonc = L.layerGroup(), casing = null, highlight = null, mode = "voie";
function setMode(m) {
  mode = m;
  document.querySelectorAll(".mapctl button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  map.removeLayer(layerVoie); map.removeLayer(layerFonc);
  (m === "voie" ? layerVoie : layerFonc).addTo(map);
}
document.querySelectorAll(".mapctl button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

function runsOf(samples, keyFn) {
  const runs = [];
  let cur = null;
  for (const s of samples) {
    const k = keyFn(s);
    if (cur && cur.k === k && cur.line === s.line) cur.pts.push([s.p[1], s.p[0]]);
    else {
      if (cur && cur.line === s.line) cur.pts.push([s.p[1], s.p[0]]); // raccord sans trou
      cur = { k, line: s.line, s, pts: [[s.p[1], s.p[0]]] };
      runs.push(cur);
    }
  }
  return runs;
}

const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function roadPopup(f) {
  if (!f) return "<b>Hors réseau IGN</b><br>Aucun tronçon BD TOPO à moins de " + ROAD_TOL + " m.";
  const p = f.properties;
  return `<b>${esc(p.nature)}</b>${p.nom_voie_ban_gauche || p.nom_collaboratif_gauche ? "<br>" + esc(p.nom_voie_ban_gauche || p.nom_collaboratif_gauche) : ""}` +
    `<br>Importance ${esc(p.importance)}${p.prive ? "<br><b>Voie privée (BD TOPO)</b>" : ""}` +
    `${p.acces_vehicule_leger && p.acces_vehicule_leger !== "Libre" ? "<br>Accès VL : " + esc(p.acces_vehicule_leger) : ""}`;
}

function parcelPopup(f, owners, crossed) {
  const p = f.properties, o = owners && owners[p.idu];
  const who = !owners ? "Propriétaire inconnu (fichier indisponible)"
    : o ? o.map((x) => `${esc(x.denomination)} <span style="color:var(--text-muted)">(${esc(x.forme || x.groupe)}, ${esc(x.droit)})</span>`).join("<br>")
    : "Particulier (absent du fichier des personnes morales)";
  return `<b>${esc(p.nom_com)}</b> — section ${esc(p.section)} n° ${esc(p.numero)}<br>` +
    `<span style="color:var(--text-muted)">${esc(p.idu)} · ${(p.contenance || 0).toLocaleString("fr-FR")} m²</span><br>${who}` +
    (crossed ? `<br>Parcouru : ${Math.round(crossed)} m` : "");
}

function drawMap(lines, samples, owners, parcelsCrossed) {
  [layerVoie, layerFonc].forEach((l) => l.clearLayers());
  if (casing) map.removeLayer(casing);
  casing = L.polyline(lines.map((l) => l.map((p) => [p[1], p[0]])), { color: "#fff", weight: 8, opacity: 0.9 }).addTo(map);

  const colorV = Object.fromEntries(VOIE.map((c) => [c.key, css(c.color)]));
  const colorF = Object.fromEntries(FONC.map((c) => [c.key, css(c.color)]));

  for (const r of runsOf(samples, (s) => s.road ? s.road.id : "hors"))
    L.polyline(r.pts, { color: colorV[r.s.voie], weight: 4 }).bindPopup(roadPopup(r.s.road)).addTo(layerVoie);

  for (const [, { f, len, cat }] of parcelsCrossed)
    L.geoJSON(f, { style: { color: colorF[cat], weight: 1, fillOpacity: 0.18 } })
      .bindPopup(parcelPopup(f, owners, len)).addTo(layerFonc);
  for (const r of runsOf(samples, (s) => s.fonc + "|" + (s.parcel ? s.parcel.id : "")))
    L.polyline(r.pts, { color: colorF[r.s.fonc], weight: 4 })
      .bindPopup(r.s.parcel ? parcelPopup(r.s.parcel, owners) : "<b>Non cadastré</b><br>Voirie ou domaine public probable.")
      .addTo(layerFonc);

  setMode(mode);
  map.fitBounds(casing.getBounds(), { padding: [20, 20] });
}

// ---------- Rendu des stats ----------
const fmtKm = (m) => (m / 1000).toLocaleString("fr-FR", { maximumFractionDigits: m < 10000 ? 2 : 1 }) + " km";
const pct = (v, t) => (t ? (100 * v / t) : 0).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " %";

function renderCats(barEl, tabEl, cats, sums, total) {
  barEl.innerHTML = ""; tabEl.innerHTML = "";
  for (const c of cats) {
    const v = sums.get(c.key) || 0;
    if (!v) continue;
    const seg = document.createElement("span");
    seg.style.flex = String(v); seg.style.background = css(c.color);
    seg.title = `${c.label} : ${fmtKm(v)} (${pct(v, total)})`;
    barEl.append(seg);
    tabEl.insertAdjacentHTML("beforeend",
      `<tr><td><span class="sw" style="background:${css(c.color)}"></span>${esc(c.label)}</td>` +
      `<td class="num">${fmtKm(v)}</td><td class="num"><b>${pct(v, total)}</b></td></tr>`);
  }
}

function download(name, rows) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  a.download = name; a.click();
}

function render(res) {
  const { name, total, elev, samples, owners, verif, parcelsCrossed } = res;
  document.getElementById("t-dist").textContent = fmtKm(total);
  document.getElementById("t-elev").textContent = `${Math.round(elev.up)} / ${Math.round(elev.down)} m`;
  document.getElementById("t-parc").textContent = parcelsCrossed.size.toLocaleString("fr-FR");

  renderCats(document.getElementById("bar-voie"), document.getElementById("tab-voie"), VOIE, sumBy(samples, (s) => s.voie), total);
  const nat = [...sumBy(samples, (s) => s.road ? s.road.properties.nature : "Hors réseau IGN")].sort((a, b) => b[1] - a[1]);
  document.getElementById("tab-nature").innerHTML = nat.map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td class="num">${fmtKm(v)}</td><td class="num">${pct(v, total)}</td></tr>`).join("");
  const prive = samples.reduce((a, s) => a + (s.road && s.road.properties.prive ? s.len : 0), 0);
  document.getElementById("note-prive").textContent = prive
    ? `Dont ${fmtKm(prive)} (${pct(prive, total)}) sur des tronçons marqués « privé » dans la BD TOPO.`
    : "Aucun tronçon marqué « privé » dans la BD TOPO.";

  renderCats(document.getElementById("bar-fonc"), document.getElementById("tab-fonc"), FONC, sumBy(samples, (s) => s.fonc), total);
  const foret = samples.reduce((a, s) => a + (s.forest ? s.len : 0), 0);
  document.getElementById("note-foret").textContent = (foret ? `${fmtKm(foret)} (${pct(foret, total)}) en forêt publique (ONF).` : "Aucun passage en forêt publique.") +
    (owners ? "" : " Propriétaires non chargés (fichier du département indisponible).");

  document.getElementById("n-verif").textContent = `(${verif.length})`;
  const tab = document.getElementById("tab-verif");
  tab.innerHTML = verif.length ? "" : `<tr><td class="muted">Aucun passage sur parcelle privée de plus de ${MIN_VERIF} m.</td></tr>`;
  verif.forEach((v) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>km ${(v.start / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 2 })}<br>` +
      `<span class="muted">${esc(v.nature)} · ${v.parcels.size} parcelle${v.parcels.size > 1 ? "s" : ""}</span></td>` +
      `<td>${esc(v.who.join(", "))}</td><td class="num">${Math.round(v.len)} m</td>`;
    tr.addEventListener("click", () => {
      if (highlight) map.removeLayer(highlight);
      setMode("fonc");
      highlight = L.polyline(v.latlngs, { color: css("--text-primary"), weight: 9, opacity: 0.35 }).addTo(map);
      map.fitBounds(highlight.getBounds(), { padding: [60, 60], maxZoom: 17 });
    });
    tab.append(tr);
  });

  document.getElementById("csv-verif").onclick = () => download(`${name}-passages.csv`, [
    ["km_debut", "longueur_m", "type_voie", "parcelles (idu)", "proprietaires"],
    ...verif.map((v) => [(v.start / 1000).toFixed(3), Math.round(v.len), v.nature, [...v.parcels.keys()].join(" "), v.who.join(", ")]),
  ]);
  document.getElementById("csv-parc").onclick = () => download(`${name}-parcelles.csv`, [
    ["idu", "commune", "section", "numero", "contenance_m2", "longueur_parcourue_m", "categorie", "proprietaires"],
    ...[...parcelsCrossed.values()].sort((a, b) => a.first - b.first).map(({ f, len, cat }) => {
      const p = f.properties, o = owners && owners[p.idu];
      return [p.idu, p.nom_com, p.section, p.numero, p.contenance, Math.round(len), FONC.find((c) => c.key === cat).label, o ? o.map((x) => x.denomination).join(", ") : ""];
    }),
  ]);

  document.getElementById("results").hidden = false;
}

// ---------- Orchestration ----------
const statusEl = document.getElementById("status");
function status(msg, frac, err) {
  statusEl.hidden = !msg;
  statusEl.className = err ? "err" : "";
  statusEl.innerHTML = esc(msg) + (frac != null ? `<progress value="${frac}" max="1"></progress>` : "");
}

// Efface la trace et tous les résultats : rien ne reste en mémoire ni sur la carte.
function clearAll() {
  [layerVoie, layerFonc].forEach((l) => l.clearLayers());
  if (casing) map.removeLayer(casing);
  if (highlight) map.removeLayer(highlight);
  casing = highlight = null;
  for (const id of ["bar-voie", "tab-voie", "tab-nature", "bar-fonc", "tab-fonc", "tab-verif"]) document.getElementById(id).innerHTML = "";
  document.getElementById("csv-verif").onclick = document.getElementById("csv-parc").onclick = null;
  document.getElementById("results").hidden = true;
  document.getElementById("file").value = "";
  status("");
  map.setView([46.6, 2.5], 6);
}
document.getElementById("clear").addEventListener("click", clearAll);

async function analyse(file) {
  clearAll();
  try {
    const lines = parseGpx(await file.text());
    const { samples, total } = sample(lines);
    status("Téléchargement des données IGN (routes, cadastre, forêts publiques)…", 0);
    const data = await fetchLayers(lines, (f) => status("Téléchargement des données IGN (routes, cadastre, forêts publiques)…", f));

    status("Rattachement aux tronçons de route…");
    await new Promise((r) => setTimeout(r));
    matchRoads(samples, data.roads);
    const inParcel = polyIndex(data.parcels), inForest = polyIndex(data.forests);
    for (const s of samples) {
      s.voie = voieCat(s.road && s.road.properties.nature);
      s.parcel = inParcel(s.snap);
      s.forest = !!inForest(s.p);
    }

    const idus = [...new Set(samples.filter((s) => s.parcel).map((s) => s.parcel.properties.idu))];
    status(`Recherche des propriétaires de ${idus.length} parcelles…`, null);
    let owners = null;
    try { owners = await fetchOwners(idus); } catch (e) { console.warn("Propriétaires indisponibles", e); }

    const parcelsCrossed = new Map();
    for (const s of samples) {
      s.fonc = foncCat(s, owners);
      if (!s.parcel) continue;
      const e = parcelsCrossed.get(s.parcel.id) || parcelsCrossed.set(s.parcel.id, { f: s.parcel, len: 0, cat: parcelCat(s.parcel, owners), first: s.at }).get(s.parcel.id);
      e.len += s.len;
    }

    const verif = verifRuns(samples, owners);
    drawMap(lines, samples, owners, parcelsCrossed);
    render({ name: file.name.replace(/\.gpx$/i, ""), total, elev: elevation(lines), samples, owners, verif, parcelsCrossed });
    status("");
  } catch (e) {
    console.error(e);
    status("Erreur : " + e.message, null, true);
  }
}

const drop = document.getElementById("drop");
document.getElementById("file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) analyse(f);
});
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && analyse(e.dataTransfer.files[0]));
// permet de tester sans glisser-déposer : ?gpx=/chemin/servi/fichier.gpx
const q = new URLSearchParams(location.search).get("gpx");
if (q) fetch(q).then((r) => r.blob()).then((b) => analyse(new File([b], q.split("/").pop())));
