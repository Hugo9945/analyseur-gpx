"use strict";

// ---------- Paramètres ----------
const WFS = "https://data.geopf.fr/wfs/ows";
const ALTI = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json";
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const STEP = 10;          // m entre deux points d'échantillonnage
const ROAD_TOL = 15;      // m : distance max pour rattacher un point à un tronçon BD TOPO / OSM
const CHUNK = 120;        // sommets par requête WFS (limite la longueur d'URL)
const MIN_VERIF = 20;     // m : longueur min d'un point d'attention
const EDGE_TOL = 4;       // m : en deçà, un point privé est « en limite de parcelle » (décalage cadastre / BD TOPO)
const SLOPE_WIN = 25;     // m de part et d'autre pour calculer la pente

const VOIE = [
  { key: "revetue",   label: "Route revêtue",      color: "--s1" },
  { key: "empierree", label: "Route empierrée",    color: "--s2" },
  { key: "chemin",    label: "Chemin",             color: "--s3" },
  { key: "sentier",   label: "Sentier / escalier", color: "--s4" },
  { key: "cyclable",  label: "Piste cyclable",     color: "--s5" },
  { key: "hors",      label: "Hors réseau IGN",    color: "--neutral" },
];
const SURF = [
  { key: "asphalte", label: "Asphalte / béton",           color: "--s1" },
  { key: "gravier",  label: "Gravier / stabilisé",        color: "--s2" },
  { key: "terre",    label: "Terre / herbe / sable",      color: "--s3" },
  { key: "cailloux", label: "Rocheux / cailloux",         color: "--s4" },
  { key: "nonrev",   label: "Non revêtu, non précisé",    color: "--s5" },
  { key: "inconnu",  label: "Inconnu",                    color: "--neutral" },
];
const FONC = [
  { key: "public",      label: "Personne publique (commune, État…)",   color: "--s1" },
  { key: "noncad",      label: "Non cadastré (voirie, domaine public)", color: "--s3" },
  { key: "limite",      label: "En limite de parcelle privée (±4 m)",  color: "--s5" },
  { key: "pmprivee",    label: "Personne morale privée (SCI, GFA…)",   color: "--s4" },
  { key: "particulier", label: "Particulier (probable)",               color: "--s8" },
  { key: "inconnu",     label: "Propriétaire inconnu",                 color: "--neutral" },
];
const SLOPES = [
  { max: 5,        label: "0 à 5 %",    color: "--q1" },
  { max: 10,       label: "5 à 10 %",   color: "--q2" },
  { max: 15,       label: "10 à 15 %",  color: "--q3" },
  { max: 20,       label: "15 à 20 %",  color: "--q4" },
  { max: 30,       label: "20 à 30 %",  color: "--q5" },
  { max: Infinity, label: "plus de 30 %", color: "--q6" },
];
// Motifs d'alerte moto (art. L362-1 du code de l'environnement : véhicules à moteur
// interdits hors des voies ouvertes à la circulation publique)
const REASONS = {
  prive:       "Parcelle privée",
  ayantsdroit: "Accès réservé aux ayants droit (IGN)",
  osm:         "Interdit aux motos d'après OSM",
  sentier:     "Sentier non carrossable (IGN)",
  zone:        "Zone protégée (cœur de parc, réserve, biotope)",
};
// Zones réglementées (couches PatriNat de la Géoplateforme)
const ZONES = [
  { layer: "patrinat_pn:parc_national", type: "Parc national", strong: (p) => p.zone === "Cœur" },
  { layer: "patrinat_rnn:rnn",     type: "Réserve naturelle nationale", strong: () => true },
  { layer: "patrinat_rnr:rnr",     type: "Réserve naturelle régionale", strong: () => true },
  { layer: "patrinat_rb:rb",       type: "Réserve biologique",          strong: () => true },
  { layer: "patrinat_apb:apb",     type: "Arrêté de protection de biotope", strong: () => true },
  { layer: "patrinat_rncfs:rncfs", type: "Réserve de chasse et de faune sauvage", strong: () => false },
  { layer: "patrinat_sic:sic",     type: "Natura 2000 (habitats)",      strong: () => false },
  { layer: "patrinat_zps:zps",     type: "Natura 2000 (oiseaux)",       strong: () => false },
  { layer: "patrinat_pnr:pnr",     type: "Parc naturel régional",       strong: () => false },
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

const PAVED = new Set(["asphalt", "concrete", "concrete:plates", "concrete:lanes", "paved", "paving_stones", "sett",
  "chipseal", "cobblestone", "unhewn_cobblestone", "bricks", "metal", "wood"]);
const GRAVEL = new Set(["gravel", "fine_gravel", "compacted"]);
const EARTH = new Set(["dirt", "earth", "ground", "grass", "mud", "sand", "soil", "clay", "woodchips", "grass_paver"]);
const ROCK = new Set(["rock", "rocks", "stone", "pebblestone"]);
const ROADS = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
  "living_street", "service", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"]);

// Revêtement : tag OSM « surface », sinon « tracktype », sinon type de voie OSM, sinon nature BD TOPO
function surfCat(t, voie) {
  const s = t && t.surface;
  if (s) {
    if (PAVED.has(s)) return "asphalte";
    if (GRAVEL.has(s)) return "gravier";
    if (EARTH.has(s)) return "terre";
    if (ROCK.has(s)) return "cailloux";
    return "nonrev";
  }
  if (t && t.tracktype) return { grade1: "asphalte", grade2: "gravier" }[t.tracktype] || "terre";
  if (t && ROADS.has(t.highway)) return "asphalte";
  if (t) return "nonrev";
  return { revetue: "asphalte", empierree: "gravier", chemin: "nonrev", sentier: "nonrev", cyclable: "asphalte" }[voie] || "inconnu";
}

const BAN = new Set(["no", "private", "agricultural", "forestry", "agricultural;forestry", "forestry;agricultural",
  "delivery", "permit", "customers"]);
// Renvoie le tag OSM qui interdit la moto, ou null
function osmMotoBan(t) {
  if (!t) return null;
  for (const k of ["motorcycle", "motor_vehicle", "vehicle", "access"])
    if (t[k]) return BAN.has(t[k]) ? `${k}=${t[k]}` : null;
  if (["footway", "path", "bridleway", "cycleway", "steps", "pedestrian"].includes(t.highway)) return `highway=${t.highway}`;
  return null;
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
        S.push({
          p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], len: d / n, at: at + d * t, line: li,
          gpxEle: a[2] != null && b[2] != null ? a[2] + (b[2] - a[2]) * t : null,
        });
      }
      at += d;
    }
  });
  return { samples: S, total: at };
}

// ---------- Sources de données ----------
function chunks(lines) {
  const out = [];
  for (const l of lines) for (let i = 0; i < l.length - 1; i += CHUNK - 1) out.push(l.slice(i, i + CHUNK));
  return out;
}
const coords = (c) => c.map((p) => `${p[1].toFixed(6)} ${p[0].toFixed(6)}`).join(",");
const wkt = (c) => `LINESTRING(${coords(c)})`;

async function getJson(url, opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
      return await r.json();
    } catch (e) {
      // 429 = quota Géoplateforme dépassé : on patiente et on réessaie
      if (attempt >= 5) throw e;
      await new Promise((ok) => setTimeout(ok, 1500 * 2 ** attempt));
    }
  }
}

function wfs(typename, params) {
  const q = new URLSearchParams({
    SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", OUTPUTFORMAT: "application/json",
    SRSNAME: "urn:ogc:def:crs:EPSG::4326", COUNT: "5000", TYPENAMES: typename, ...params,
  });
  return getJson(`${WFS}?${q}`).then((j) => j.features);
}

async function pool(tasks, n, tick = () => {}) {
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
    roads:   (w) => wfs("BDTOPO_V3:troncon_de_route", { CQL_FILTER: `DWITHIN(geometrie,${w},20,meters)` }),
    parcels: (w) => wfs("CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle", { CQL_FILTER: `DWITHIN(geom,${w},8,meters)` }),
    forests: (w) => wfs("BDTOPO_V3:foret_publique", { CQL_FILTER: `INTERSECTS(geometrie,${w})` }),
  };
  const tasks = [];
  for (const [name, fn] of Object.entries(layers)) for (const c of cs) tasks.push(() => fn(wkt(c)).then((f) => [name, f]));
  let done = 0;
  const res = await pool(tasks, 3, () => progress(++done / tasks.length));
  const out = { roads: new Map(), parcels: new Map(), forests: new Map() };
  for (const [name, feats] of res) for (const f of feats) out[name].set(f.id, f);
  return { roads: [...out.roads.values()], parcels: [...out.parcels.values()], forests: [...out.forests.values()] };
}

// Les zones sont de grands polygones : on repère d'abord lesquelles touchent la trace (sans géométrie),
// puis on télécharge la géométrie de chacune une seule fois.
async function fetchZones(lines) {
  const ml = turf.multiLineString(lines.map((l) => l.map((p) => [p[0], p[1]])));
  let simple = ml, tol = 0.0002;
  const count = (g) => g.geometry.coordinates.reduce((a, c) => a + c.length, 0);
  while (count(simple) > 150) { tol *= 2; simple = turf.simplify(ml, { tolerance: tol }); }
  // couches stockées en Lambert 93 : projection explicite, coordonnées en longitude latitude
  const lonlat = (c) => c.map((p) => `${p[0].toFixed(6)} ${p[1].toFixed(6)}`).join(",");
  const w = `SRID=4326;MULTILINESTRING(${simple.geometry.coordinates.map((c) => `(${lonlat(c)})`).join(",")})`;
  const res = await pool(ZONES.map((z) => async () => {
    const hits = await wfs(z.layer, { CQL_FILTER: `DWITHIN(geom,${w},100,meters)`, PROPERTYNAME: "nom_site" });
    if (!hits.length) return [];
    const feats = await wfs(z.layer, { FEATUREID: hits.map((f) => f.id).join(",") });
    return feats.map((f) => Object.assign(f, { def: z, strong: z.strong(f.properties) }));
  }), 3);
  return res.flat();
}

// Voies OSM (revêtement, interdictions) : une seule requête Overpass, par tuiles d'environ 1 km
async function fetchOsm(samples) {
  const c = 0.01, pad = 0.0003, tiles = new Set();
  for (const s of samples) tiles.add(Math.floor(s.p[1] / c) + ":" + Math.floor(s.p[0] / c));
  const boxes = [...tiles].map((t) => {
    const [i, j] = t.split(":").map(Number);
    return `way[highway](${(i * c - pad).toFixed(4)},${(j * c - pad).toFixed(4)},${((i + 1) * c + pad).toFixed(4)},${((j + 1) * c + pad).toFixed(4)});`;
  });
  const q = `[out:json][timeout:120];(${boxes.join("")});out tags geom qt;`;
  for (const url of OVERPASS) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 90000);
    try {
      const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), signal: ctl.signal });
      if (!r.ok) throw new Error(`OSM ${r.status}`);
      const j = await r.json();
      return j.elements.filter((e) => e.geometry).map((e) => ({
        id: "osm" + e.id, properties: e.tags, geometry: { type: "LineString", coordinates: e.geometry.map((g) => [g.lon, g.lat]) },
      }));
    } catch (e) {
      console.warn("Overpass", url, e);
    } finally { clearTimeout(timer); }
  }
  throw new Error("OpenStreetMap indisponible");
}

// Altitudes IGN (RGE ALTI) pour chaque point échantillonné
async function fetchAlti(samples) {
  const B = 1500, tasks = [];
  for (let i = 0; i < samples.length; i += B) {
    const part = samples.slice(i, i + B);
    tasks.push(async () => {
      const j = await getJson(ALTI, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lon: part.map((s) => s.p[0].toFixed(6)).join("|"), lat: part.map((s) => s.p[1].toFixed(6)).join("|"),
          resource: "ign_rge_alti_wld", zonly: "true",
        }),
      });
      j.elevations.forEach((z, k) => { part[k].ele = z > -1000 ? z : null; });
    });
  }
  await pool(tasks, 2);
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
  const dep = (i) => (i.startsWith("97") ? i.slice(0, 3) : i.slice(0, 2));
  const deps = [...new Set(idus.map(dep))];
  const tables = Object.fromEntries(await Promise.all(deps.map(async (d) => [d, await loadDept(d)])));
  const out = {};
  for (const idu of idus) {
    const t = tables[dep(idu)];
    const rows = t.p[idu];
    if (rows) out[idu] = rows.map(([n, g, f, d]) => ({ denomination: t.n[n], groupe: t.g[g], forme: t.f[f], droit: t.d[d] }));
  }
  return out;
}

// ---------- Analyse ----------
function lineParts(g) {
  return g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
}

// Rattache chaque point au tronçon le plus proche (à moins de ROAD_TOL m) ; renvoie [feature, point projeté]
function matchNearest(samples, feats, { groundPenalty = false } = {}) {
  const grid = new Grid();
  const pad = 0.0003;
  for (const f of feats) for (const part of lineParts(f.geometry)) for (let i = 1; i < part.length; i++) {
    const a = part[i - 1], b = part[i];
    grid.add([Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad], { f, a, b });
  }
  let prev = null;
  return samples.map((s) => {
    const best = new Map(); // feature -> {d,q}
    for (const seg of grid.at(s.p[0], s.p[1])) {
      const r = segDist(s.p, seg.a, seg.b);
      // les ponts / tunnels passent après les tronçons au sol
      if (groundPenalty && seg.f.properties.position_par_rapport_au_sol !== "0") r.d += 5;
      const cur = best.get(seg.f);
      if (!cur || r.d < cur.d) best.set(seg.f, r);
    }
    let pick = null;
    for (const [f, r] of best) if (r.d <= ROAD_TOL && (!pick || r.d < pick.r.d)) pick = { f, r };
    // hystérésis : on reste sur le tronçon précédent s'il est presque aussi proche (carrefours)
    if (pick && prev && pick.f !== prev && best.has(prev) && best.get(prev).d <= pick.r.d + 3) pick = { f: prev, r: best.get(prev) };
    prev = pick ? pick.f : null;
    return pick ? [pick.f, pick.r.q] : [null, s.p];
  });
}

function polyIndex(features, all = false) {
  const grid = new Grid(0.005);
  for (const f of features) { f.bbox = turf.bbox(f); grid.add(f.bbox, f); }
  return (p) => {
    const hits = [];
    for (const f of grid.at(p[0], p[1])) {
      const b = f.bbox;
      if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) continue;
      if (turf.booleanPointInPolygon(p, f)) { if (!all) return f; hits.push(f); }
    }
    return all ? hits : null;
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

function motoReasons(s) {
  const r = [];
  if (s.fonc === "particulier" || s.fonc === "pmprivee") r.push("prive");
  const p = s.road && s.road.properties;
  if (p && (p.acces_vehicule_leger === "Restreint aux ayants droit" || p.prive)) r.push("ayantsdroit");
  if (osmMotoBan(s.osm && s.osm.properties)) r.push("osm");
  if (s.voie === "sentier" || (p && p.acces_vehicule_leger === "Physiquement impossible")) r.push("sentier");
  if (s.zones.some((z) => z.strong)) r.push("zone");
  return r;
}

function slopes(samples) {
  // altitude : IGN si disponible, sinon celle du GPX ; légère moyenne glissante pour le dénivelé
  for (const s of samples) s.z = s.ele ?? s.gpxEle;
  const ok = samples.some((s) => s.z != null);
  let up = 0, down = 0, max = null;
  for (let i = 0, j = 0, k = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.z == null) { s.grade = null; continue; }
    while (samples[j].line !== s.line || s.at - samples[j].at > SLOPE_WIN) j++;
    k = Math.max(k, i);
    while (k + 1 < samples.length && samples[k + 1].line === s.line && samples[k + 1].at - s.at <= SLOPE_WIN) k++;
    const a = samples[j], b = samples[k], d = b.at - a.at;
    s.grade = d > 15 && a.z != null && b.z != null ? (100 * (b.z - a.z)) / d : null;
    if (s.grade != null && (!max || Math.abs(s.grade) > Math.abs(max.grade))) max = s;
  }
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.line !== b.line || a.z == null || b.z == null) continue;
    const d = b.z - a.z;
    if (d > 0) up += d; else down -= d;
  }
  return ok ? { up, down, max } : null;
}

function sumBy(samples, keyFn) {
  const m = new Map();
  for (const s of samples) { const k = keyFn(s); m.set(k, (m.get(k) || 0) + s.len); }
  return m;
}
const sumIf = (samples, fn) => samples.reduce((a, s) => a + (fn(s) ? s.len : 0), 0);

// Tronçons contigus d'au moins MIN_VERIF m avec au moins un motif d'alerte moto
function alertRuns(samples, owners) {
  const runs = [];
  let cur = null;
  for (const s of samples) {
    if (s.reasons.length && cur && cur.line === s.line) cur.samples.push(s);
    else {
      if (cur) runs.push(cur);
      cur = s.reasons.length ? { line: s.line, samples: [s] } : null;
    }
  }
  if (cur) runs.push(cur);
  return runs.map(({ samples: ss }) => {
    const len = ss.reduce((a, s) => a + s.len, 0);
    const reasons = sumBy(ss.flatMap((s) => s.reasons.map((r) => ({ r, len: s.len }))), (x) => x.r);
    const parcels = new Map(), zones = new Set(), osmTags = new Set();
    for (const s of ss) {
      if (s.reasons.includes("prive")) parcels.set(s.parcel.properties.idu, s.parcel);
      for (const z of s.zones) if (z.strong) zones.add(`${z.def.type} « ${z.properties.nom_site} »`);
      const ban = osmMotoBan(s.osm && s.osm.properties);
      if (ban) osmTags.add(ban);
    }
    const who = [...parcels.keys()].map((i) => owners && owners[i] ? owners[i].map((o) => o.denomination).join(", ") : "particulier")
      .filter((v, i, a) => a.indexOf(v) === i);
    const nature = [...sumBy(ss, (s) => s.road ? s.road.properties.nature : "Hors réseau IGN")].sort((a, b) => b[1] - a[1])[0][0];
    const surf = [...sumBy(ss, (s) => s.surf)].sort((a, b) => b[1] - a[1])[0][0];
    return { start: ss[0].at, len, reasons, parcels, who, zones: [...zones], osmTags: [...osmTags], nature, surf,
      latlngs: ss.map((s) => [s.p[1], s.p[0]]) };
  }).filter((r) => r.len >= MIN_VERIF);
}

// OpenStreetMap répond souvent en plus d'une minute : la trace s'affiche d'abord avec les données IGN,
// puis applyOsm() complète revêtement, interdictions et alertes quand OSM arrive.
async function analyseTrace(file, progress) {
  const lines = parseGpx(await file.text());
  const { samples, total } = sample(lines);
  const osmPromise = fetchOsm(samples);

  const state = { ign: 0, alti: "…" };
  const tell = () => progress(`Données IGN ${Math.round(state.ign * 100)} % · altitudes ${state.alti}`, state.ign);
  tell();
  const [ign, zones, alti] = await Promise.allSettled([
    fetchLayers(lines, (f) => { state.ign = f; tell(); }),
    fetchZones(lines),
    fetchAlti(samples).finally(() => { state.alti = "✓"; tell(); }),
  ]);
  if (ign.status === "rejected") throw ign.reason;
  const data = ign.value;
  const notes = [];
  if (zones.status === "rejected") notes.push("Zones protégées non chargées (Géoplateforme indisponible).");
  if (alti.status === "rejected") notes.push("Altitudes IGN indisponibles : altitudes du fichier GPX utilisées.");

  progress("Croisement des données…", null);
  await new Promise((r) => setTimeout(r));
  matchNearest(samples, data.roads, { groundPenalty: true }).forEach(([f, q], i) => { samples[i].road = f; samples[i].snap = q; });
  const inParcel = polyIndex(data.parcels), inForest = polyIndex(data.forests);
  const inZones = polyIndex(zones.status === "fulfilled" ? zones.value : [], true);
  for (const s of samples) {
    s.voie = voieCat(s.road && s.road.properties.nature);
    s.parcel = inParcel(s.snap);
    s.forest = !!inForest(s.p);
    s.zones = inZones(s.p);
  }

  const idus = [...new Set(samples.filter((s) => s.parcel).map((s) => s.parcel.properties.idu))];
  progress(`Recherche des propriétaires de ${idus.length} parcelles…`, null);
  let owners = null;
  try { owners = await fetchOwners(idus); } catch (e) {
    console.warn("Propriétaires indisponibles", e);
    notes.push("Propriétaires non chargés (fichier du département indisponible).");
  }

  const parcelsCrossed = new Map();
  for (const s of samples) {
    s.fonc = foncCat(s, owners);
    if (!s.parcel) continue;
    const e = parcelsCrossed.get(s.parcel.id) || parcelsCrossed.set(s.parcel.id, { f: s.parcel, len: 0, cat: parcelCat(s.parcel, owners), first: s.at }).get(s.parcel.id);
    e.len += s.len;
  }
  const zonesCrossed = new Map();
  for (const s of samples) for (const z of s.zones) {
    const e = zonesCrossed.get(z.id) || zonesCrossed.set(z.id, { z, len: 0, first: s.at }).get(z.id);
    e.len += s.len;
  }

  const res = { name: file.name.replace(/\.gpx$/i, ""), lines, samples, total, elev: slopes(samples), owners,
    parcelsCrossed, zonesCrossed, notes, osm: "pending" };
  applyOsm(res, null);
  return { res, osmPromise };
}

// Calcule (ou recalcule) tout ce qui dépend d'OpenStreetMap
function applyOsm(res, feats) {
  const { samples, total, elev, owners } = res;
  if (feats) matchNearest(samples, feats).forEach(([f], i) => { samples[i].osm = f; });
  for (const s of samples) {
    s.surf = surfCat(s.osm && s.osm.properties, s.voie);
    s.reasons = motoReasons(s);
  }
  res.alerts = alertRuns(samples, owners);
  const pctOf = (fn) => (100 * sumIf(samples, fn)) / total;
  res.sum = {
    total, up: elev ? elev.up : null,
    revetue: pctOf((s) => s.voie === "revetue"), chemin: pctOf((s) => s.voie === "chemin" || s.voie === "empierree"),
    sentier: pctOf((s) => s.voie === "sentier"), offroad: pctOf((s) => s.surf === "terre" || s.surf === "cailloux"),
    prive: pctOf((s) => s.fonc === "particulier" || s.fonc === "pmprivee"),
    alertKm: sumIf(samples, (s) => s.reasons.length) / 1000, alertN: res.alerts.length,
  };
}

// ---------- Carte ----------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const map = L.map("map", { zoomControl: false }).setView([46.6, 2.5], 6);
L.control.zoom({ position: "bottomleft" }).addTo(map); // le haut est réservé aux boutons de couleur
const wmts = (layer, fmt = "image/png", style = "normal") => L.tileLayer(
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${encodeURIComponent(style)}` +
  `&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${fmt}`,
  { maxZoom: 20, maxNativeZoom: 19, attribution: '© IGN · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
const plan = wmts("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2").addTo(map);
const ortho = wmts("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg");
const cadastre = wmts("CADASTRALPARCELS.PARCELLAIRE_EXPRESS", "image/png", "PCI vecteur");
L.control.layers({ "Plan IGN": plan, "Photo aérienne": ortho }, { "Cadastre": cadastre }, { position: "bottomright" }).addTo(map);

const layers = { moto: L.layerGroup(), voie: L.layerGroup(), surf: L.layerGroup(), fonc: L.layerGroup() };
const others = L.layerGroup().addTo(map);
let casing = null, highlight = null, cursor = null, mode = "moto";
function setMode(m) {
  mode = m;
  document.querySelectorAll(".mapctl button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  for (const [k, l] of Object.entries(layers)) k === m ? l.addTo(map) : map.removeLayer(l);
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
const muted = (t) => `<span style="color:var(--text-muted)">${t}</span>`;

function roadPopup(f) {
  if (!f) return "<b>Hors réseau IGN</b><br>Aucun tronçon BD TOPO à moins de " + ROAD_TOL + " m.";
  const p = f.properties;
  return `<b>${esc(p.nature)}</b>${p.nom_voie_ban_gauche || p.nom_collaboratif_gauche ? "<br>" + esc(p.nom_voie_ban_gauche || p.nom_collaboratif_gauche) : ""}` +
    `<br>Importance ${esc(p.importance)}${p.prive ? "<br><b>Voie privée (BD TOPO)</b>" : ""}` +
    `${p.acces_vehicule_leger && p.acces_vehicule_leger !== "Libre" ? "<br>Accès VL : " + esc(p.acces_vehicule_leger) : ""}`;
}

function osmPopup(s) {
  const t = s.osm && s.osm.properties;
  const label = SURF.find((c) => c.key === s.surf).label;
  if (!t) return `<b>${label}</b><br>${muted("Pas de voie OSM à moins de " + ROAD_TOL + " m : déduit de la BD TOPO.")}`;
  const tags = ["highway", "surface", "tracktype", "smoothness", "motorcycle", "motor_vehicle", "access"]
    .filter((k) => t[k]).map((k) => `${k}=${esc(t[k])}`).join("<br>");
  return `<b>${label}</b>${t.name ? "<br>" + esc(t.name) : ""}<br>${muted(tags)}`;
}

function parcelPopup(f, owners, crossed) {
  const p = f.properties, o = owners && owners[p.idu];
  const who = !owners ? "Propriétaire inconnu (fichier indisponible)"
    : o ? o.map((x) => `${esc(x.denomination)} ${muted(`(${esc(x.forme || x.groupe)}, ${esc(x.droit)})`)}`).join("<br>")
    : "Particulier (absent du fichier des personnes morales)";
  return `<b>${esc(p.nom_com)}</b> — section ${esc(p.section)} n° ${esc(p.numero)}<br>` +
    `${muted(`${esc(p.idu)} · ${(p.contenance || 0).toLocaleString("fr-FR")} m²`)}<br>${who}` +
    (crossed ? `<br>Parcouru : ${Math.round(crossed)} m` : "");
}

function motoPopup(s, owners) {
  if (!s.reasons.length) return "<b>Aucune restriction connue</b><br>" + muted("Voie a priori ouverte : vérifier la signalisation sur place.");
  const lines = s.reasons.map((r) => {
    if (r === "prive") return `${REASONS[r]} : ${parcelPopup(s.parcel, owners)}`;
    if (r === "osm") return `${REASONS[r]} ${muted("(" + esc(osmMotoBan(s.osm.properties)) + ")")}`;
    if (r === "zone") return `${REASONS[r]} : ${s.zones.filter((z) => z.strong).map((z) => esc(z.properties.nom_site)).join(", ")}`;
    return REASONS[r];
  });
  return `<b>Point d'attention moto</b><br>${lines.join("<br>")}`;
}

function drawMap(res, fit = true) {
  Object.values(layers).forEach((l) => l.clearLayers());
  if (casing) map.removeLayer(casing);
  if (highlight) map.removeLayer(highlight);
  highlight = null;
  const { lines, samples, owners, parcelsCrossed, zonesCrossed } = res;
  casing = L.polyline(lines.map((l) => l.map((p) => [p[1], p[0]])), { color: "#fff", weight: 8, opacity: 0.9 }).addTo(map);

  const col = (cats) => Object.fromEntries(cats.map((c) => [c.key, css(c.color)]));
  const colorV = col(VOIE), colorS = col(SURF), colorF = col(FONC);

  for (const [, { z }] of zonesCrossed)
    L.geoJSON(z, { style: { color: css(z.strong ? "--s8" : "--s5"), weight: 1, dashArray: "4 4", fillOpacity: z.strong ? 0.1 : 0.04 }, interactive: false })
      .addTo(layers.moto);
  for (const r of runsOf(samples, (s) => s.reasons.join(",")))
    L.polyline(r.pts, { color: css(r.k ? "--s8" : "--s3"), weight: r.k ? 5 : 4 }).bindPopup(motoPopup(r.s, owners)).addTo(layers.moto);

  for (const r of runsOf(samples, (s) => s.road ? s.road.id : "hors"))
    L.polyline(r.pts, { color: colorV[r.s.voie], weight: 4 }).bindPopup(roadPopup(r.s.road)).addTo(layers.voie);

  for (const r of runsOf(samples, (s) => s.surf + "|" + (s.osm ? s.osm.id : "")))
    L.polyline(r.pts, { color: colorS[r.s.surf], weight: 4 }).bindPopup(osmPopup(r.s)).addTo(layers.surf);

  for (const [, { f, len, cat }] of parcelsCrossed)
    L.geoJSON(f, { style: { color: colorF[cat], weight: 1, fillOpacity: 0.18 } })
      .bindPopup(parcelPopup(f, owners, len)).addTo(layers.fonc);
  for (const r of runsOf(samples, (s) => s.fonc + "|" + (s.parcel ? s.parcel.id : "")))
    L.polyline(r.pts, { color: colorF[r.s.fonc], weight: 4 })
      .bindPopup(r.s.parcel ? parcelPopup(r.s.parcel, owners) : "<b>Non cadastré</b><br>Voirie ou domaine public probable.")
      .addTo(layers.fonc);

  setMode(mode);
  if (fit) map.fitBounds(casing.getBounds(), { padding: [20, 20] });
}

function drawOthers() {
  others.clearLayers();
  for (const t of traces) if (t !== active)
    L.polyline(t.res.lines.map((l) => l.map((p) => [p[1], p[0]])), { color: css("--neutral"), weight: 3, opacity: 0.8 })
      .bindTooltip(esc(t.res.name)).on("click", () => select(t)).addTo(others);
}

function showCursor(s) {
  if (!s) { if (cursor) map.removeLayer(cursor); cursor = null; return; }
  const ll = [s.p[1], s.p[0]];
  if (!cursor) cursor = L.circleMarker(ll, { radius: 7, color: "#fff", weight: 2, fillColor: css("--text-primary"), fillOpacity: 1 }).addTo(map);
  else cursor.setLatLng(ll);
}

// ---------- Rendu ----------
const fmtKm = (m) => (m / 1000).toLocaleString("fr-FR", { maximumFractionDigits: m < 10000 ? 2 : 1 }) + " km";
const pct = (v, t) => (t ? (100 * v / t) : 0).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " %";
const fmtPct = (v) => Math.round(v).toLocaleString("fr-FR") + " %";
const $ = (id) => document.getElementById(id);

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

// Profil d'altitude, coloré par type de voie, avec curseur synchronisé sur la carte
function drawProfile(res) {
  const box = $("profile"), tip = $("profile-tip");
  const S = res.samples.filter((s) => s.z != null);
  box.querySelector("svg")?.remove();
  if (S.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  const W = Math.max(box.clientWidth, 280), H = 170, ml = 40, mr = 8, mt = 8, mb = 22;
  let zmin = Math.min(...S.map((s) => s.z)), zmax = Math.max(...S.map((s) => s.z));
  const pad = Math.max(10, (zmax - zmin) * 0.1); zmin = Math.floor((zmin - pad) / 10) * 10; zmax = Math.ceil((zmax + pad) / 10) * 10;
  const x = (at) => ml + (at / res.total) * (W - ml - mr), y = (z) => mt + (1 - (z - zmin) / (zmax - zmin)) * (H - mt - mb);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Profil d'altitude coloré par type de voie");
  const el = (tag, attrs, parent = svg) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.append(e); return e; };

  const nice = (span, n) => { const r = span / n, p = 10 ** Math.floor(Math.log10(r)); return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= r); };
  const zs = nice(zmax - zmin, 3);
  for (let z = Math.ceil(zmin / zs) * zs; z <= zmax; z += zs) {
    el("line", { x1: ml, x2: W - mr, y1: y(z), y2: y(z), class: "grid" });
    el("text", { x: ml - 6, y: y(z) + 4, "text-anchor": "end", class: "axis" }).textContent = `${z} m`;
  }
  const ks = nice(res.total / 1000, 5);
  for (let k = 0; k <= res.total / 1000; k += ks)
    el("text", { x: x(k * 1000), y: H - 6, "text-anchor": "middle", class: "axis" }).textContent = `${k} km`;

  const colorV = Object.fromEntries(VOIE.map((c) => [c.key, css(c.color)]));
  let run = null;
  const flush = () => {
    if (!run || run.pts.length < 2) return;
    const d = `M${x(run.pts[0].at)},${y(zmin)} ` + run.pts.map((s) => `L${x(s.at).toFixed(1)},${y(s.z).toFixed(1)}`).join(" ") + ` L${x(run.pts.at(-1).at)},${y(zmin)} Z`;
    el("path", { d, fill: colorV[run.voie], "fill-opacity": 0.85 });
  };
  for (const s of S) {
    if (run && run.voie === s.voie && run.line === s.line) run.pts.push(s);
    else { if (run && run.line === s.line) run.pts.push(s); flush(); run = { voie: s.voie, line: s.line, pts: [s] }; }
  }
  flush();
  el("path", { d: "M" + S.map((s) => `${x(s.at).toFixed(1)},${y(s.z).toFixed(1)}`).join(" L"), fill: "none", class: "profile-line" });

  const vline = el("line", { y1: mt, y2: H - mb, class: "cross", visibility: "hidden" });
  const dot = el("circle", { r: 4, class: "cross-dot", visibility: "hidden" });
  const hit = el("rect", { x: ml, y: 0, width: W - ml - mr, height: H, fill: "transparent" });
  const find = (px) => {
    const at = ((px - ml) / (W - ml - mr)) * res.total;
    let lo = 0, hi = S.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].at < at) lo = m + 1; else hi = m; }
    return S[lo];
  };
  const move = (e) => {
    const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    const s = find(px);
    vline.setAttribute("x1", x(s.at)); vline.setAttribute("x2", x(s.at)); vline.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(s.at)); dot.setAttribute("cy", y(s.z)); dot.setAttribute("visibility", "visible");
    const g = s.grade == null ? "" : ` · pente ${s.grade > 0 ? "+" : ""}${Math.round(s.grade)} %`;
    tip.innerHTML = `<b>km ${(s.at / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 2 })}</b> · ${Math.round(s.z)} m${g}<br>` +
      `${esc(VOIE.find((c) => c.key === s.voie).label)} · ${esc(SURF.find((c) => c.key === s.surf).label)}`;
    tip.hidden = false;
    const left = Math.min(Math.max((x(s.at) / W) * r.width - tip.offsetWidth / 2, 0), r.width - tip.offsetWidth);
    tip.style.left = `${left}px`;
    showCursor(s);
  };
  const leave = () => { vline.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; showCursor(null); };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", leave);
  box.prepend(svg);
}

function renderAlerts(res) {
  const { alerts, name, owners, parcelsCrossed } = res;
  $("n-alert").textContent = `(${alerts.length})`;
  const tab = $("tab-alert");
  tab.innerHTML = alerts.length ? "" : `<tr><td class="muted">Aucun point d'attention de plus de ${MIN_VERIF} m.</td></tr>`;
  for (const a of alerts) {
    const why = [...a.reasons.keys()].map((r) => REASONS[r]);
    const detail = [a.who.length ? "Propriétaire : " + a.who.join(", ") : "", a.zones.join(", "), a.osmTags.length ? "OSM : " + a.osmTags.join(", ") : ""].filter(Boolean);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>km ${(a.start / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 2 })}<br>` +
      `<span class="muted">${esc(a.nature)} · ${esc(SURF.find((c) => c.key === a.surf).label)}</span></td>` +
      `<td><b>${esc(why.join(" · "))}</b>${detail.length ? `<br><span class="muted">${esc(detail.join(" — "))}</span>` : ""}</td>` +
      `<td class="num">${Math.round(a.len)} m</td>`;
    tr.addEventListener("click", () => {
      if (highlight) map.removeLayer(highlight);
      setMode("moto");
      highlight = L.polyline(a.latlngs, { color: css("--text-primary"), weight: 9, opacity: 0.35 }).addTo(map);
      map.fitBounds(highlight.getBounds(), { padding: [60, 60], maxZoom: 17 });
      if (window.matchMedia("(max-width: 800px)").matches) $("map").scrollIntoView({ behavior: "smooth" });
    });
    tab.append(tr);
  }
  $("csv-alert").onclick = () => download(`${name}-points-attention.csv`, [
    ["km_debut", "longueur_m", "motifs", "type_voie", "revetement", "parcelles (idu)", "proprietaires", "zones", "tags_osm"],
    ...alerts.map((a) => [(a.start / 1000).toFixed(3), Math.round(a.len), [...a.reasons.keys()].map((r) => REASONS[r]).join(" · "),
      a.nature, SURF.find((c) => c.key === a.surf).label, [...a.parcels.keys()].join(" "), a.who.join(", "), a.zones.join(", "), a.osmTags.join(" ")]),
  ]);
  $("csv-parc").onclick = () => download(`${name}-parcelles.csv`, [
    ["idu", "commune", "section", "numero", "contenance_m2", "longueur_parcourue_m", "categorie", "proprietaires"],
    ...[...parcelsCrossed.values()].sort((a, b) => a.first - b.first).map(({ f, len, cat }) => {
      const p = f.properties, o = owners && owners[p.idu];
      return [p.idu, p.nom_com, p.section, p.numero, p.contenance, Math.round(len), FONC.find((c) => c.key === cat).label, o ? o.map((x) => x.denomination).join(", ") : ""];
    }),
  ]);
}

function render(res) {
  const { total, elev, samples, zonesCrossed, notes } = res;
  $("t-dist").textContent = fmtKm(total);
  $("t-elev").textContent = elev ? `${Math.round(elev.up)} / ${Math.round(elev.down)} m` : "—";
  $("t-slope").textContent = elev && elev.max ? `${Math.round(Math.abs(elev.max.grade))} %` : "—";
  $("t-alert").textContent = `${res.alerts.length} · ${fmtKm(res.sum.alertKm * 1000)}`;
  $("notes").innerHTML = notes.map((n) => `<p class="note warn">${esc(n)}</p>`).join("") +
    (res.osm === "pending" ? `<p class="note">OpenStreetMap en cours… les interdictions OSM et le revêtement s'ajouteront tout seuls.</p>` : "") +
    (res.osm === "fail" ? `<p class="note warn">OpenStreetMap n'a pas répondu : interdictions OSM non vérifiées.</p>` : "");

  // Accès moto : un point peut cumuler plusieurs motifs, d'où un tableau plutôt qu'une barre
  const free = sumIf(samples, (s) => !s.reasons.length);
  $("tab-moto").innerHTML = `<tr><td><span class="sw" style="background:${css("--s3")}"></span>Aucune restriction connue</td>` +
    `<td class="num">${fmtKm(free)}</td><td class="num"><b>${pct(free, total)}</b></td></tr>` +
    Object.entries(REASONS).map(([k, label]) => {
      const v = sumIf(samples, (s) => s.reasons.includes(k));
      return v ? `<tr><td><span class="sw" style="background:${css("--s8")}"></span>${esc(label)}</td><td class="num">${fmtKm(v)}</td><td class="num">${pct(v, total)}</td></tr>` : "";
    }).join("");
  renderAlerts(res);

  renderCats($("bar-voie"), $("tab-voie"), VOIE, sumBy(samples, (s) => s.voie), total);
  const nat = [...sumBy(samples, (s) => s.road ? s.road.properties.nature : "Hors réseau IGN")].sort((a, b) => b[1] - a[1]);
  $("tab-nature").innerHTML = nat.map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td class="num">${fmtKm(v)}</td><td class="num">${pct(v, total)}</td></tr>`).join("");

  renderCats($("bar-surf"), $("tab-surf"), SURF, sumBy(samples, (s) => s.surf), total);
  const tagged = sumIf(samples, (s) => s.osm && (s.osm.properties.surface || s.osm.properties.tracktype));
  $("note-surf").textContent = {
    ok: `Revêtement renseigné explicitement dans OpenStreetMap sur ${pct(tagged, total)} du parcours ; le reste est déduit du type de voie.`,
    pending: "OpenStreetMap en cours de chargement (jusqu'à 2 min) : revêtement provisoirement déduit de la BD TOPO.",
    fail: "OpenStreetMap n'a pas répondu : revêtement déduit de la BD TOPO et interdictions OSM non vérifiées.",
  }[res.osm];

  drawProfile(res);
  const slopeSums = sumBy(samples.filter((s) => s.grade != null), (s) => SLOPES.find((c) => Math.abs(s.grade) < c.max).label);
  renderCats($("bar-slope"), $("tab-slope"), SLOPES.map((c) => ({ ...c, key: c.label })), slopeSums, sumIf(samples, (s) => s.grade != null));
  if (elev && elev.max) $("note-slope").textContent =
    `Pente maximale ${Math.round(Math.abs(elev.max.grade))} % (${elev.max.grade > 0 ? "montée" : "descente"}) au km ${(elev.max.at / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}, sur ${VOIE.find((c) => c.key === elev.max.voie).label.replace(/^./, (c) => c.toLowerCase())}. Pentes calculées sur 50 m, montée et descente confondues.`;

  const zs = [...zonesCrossed.values()].sort((a, b) => b.z.strong - a.z.strong || a.first - b.first);
  $("tab-zones").innerHTML = zs.length ? zs.map(({ z, len }) =>
    `<tr><td><span class="badge ${z.strong ? "bad" : "warn"}">${z.strong ? "Interdit probable" : "Vigilance"}</span> ` +
    `<a href="${esc(z.properties.url_fiche)}" target="_blank" rel="noopener">${esc(z.properties.nom_site)}</a><br>` +
    `<span class="muted">${esc(z.def.type)}${z.properties.zone ? " · " + esc(z.properties.zone) : ""}</span></td>` +
    `<td class="num">${fmtKm(len)}</td></tr>`).join("")
    : `<tr><td class="muted">Aucune zone réglementée traversée.</td></tr>`;

  renderCats($("bar-fonc"), $("tab-fonc"), FONC, sumBy(samples, (s) => s.fonc), total);
  const foret = sumIf(samples, (s) => s.forest);
  $("note-foret").textContent = foret ? `${fmtKm(foret)} (${pct(foret, total)}) en forêt publique (ONF) : les routes forestières y sont souvent fermées aux véhicules.` : "Aucun passage en forêt publique.";

  $("results").hidden = false;
}

// ---------- Plusieurs traces ----------
const traces = [];
let active = null;

function select(t) {
  active = t;
  drawOthers();
  drawMap(t.res, true);
  render(t.res);
  renderTraces();
}

function renderTraces() {
  $("traces").hidden = !traces.length;
  $("trace-list").innerHTML = "";
  for (const t of traces) {
    const b = document.createElement("button");
    b.className = "chip" + (t === active ? " on" : "");
    b.textContent = t.res.name;
    b.addEventListener("click", () => select(t));
    $("trace-list").append(b);
  }
  const cmp = $("compare");
  cmp.hidden = traces.length < 2;
  if (traces.length < 2) return;
  const head = ["Trace", "Distance", "D+", "Route revêtue", "Chemin", "Sentier", "Terre / cailloux", "Privé", "Alertes moto"];
  cmp.querySelector("thead").innerHTML = `<tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${h}</th>`).join("")}</tr>`;
  const body = cmp.querySelector("tbody");
  body.innerHTML = "";
  for (const t of traces) {
    const s = t.res.sum;
    const tr = document.createElement("tr");
    if (t === active) tr.className = "on";
    tr.innerHTML = `<td>${esc(t.res.name)}</td><td class="num">${fmtKm(s.total)}</td><td class="num">${s.up == null ? "—" : Math.round(s.up) + " m"}</td>` +
      [s.revetue, s.chemin, s.sentier, s.offroad, s.prive].map((v) => `<td class="num">${fmtPct(v)}</td>`).join("") +
      `<td class="num">${s.alertN} · ${s.alertKm.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km</td>`;
    tr.addEventListener("click", () => select(t));
    body.append(tr);
  }
}

// Efface une trace (ou toutes) : rien ne reste en mémoire ni sur la carte.
function removeTrace(t) {
  if (t) traces.splice(traces.indexOf(t), 1);
  else traces.length = 0;
  if (traces.length) return select(traces.at(-1));
  active = null;
  Object.values(layers).forEach((l) => l.clearLayers());
  others.clearLayers();
  for (const l of [casing, highlight]) if (l) map.removeLayer(l);
  casing = highlight = null;
  showCursor(null);
  $("results").hidden = true;
  renderTraces();
  map.setView([46.6, 2.5], 6);
}
$("clear").addEventListener("click", () => active && removeTrace(active));
$("clear-all").addEventListener("click", () => removeTrace(null));

// ---------- Orchestration ----------
const statusEl = $("status");
function status(msg, frac, err) {
  statusEl.hidden = !msg;
  statusEl.className = err ? "err" : "";
  statusEl.innerHTML = esc(msg) + (frac != null ? `<progress value="${frac}" max="1"></progress>` : "");
}

async function analyseFiles(files) {
  for (const [i, file] of [...files].entries()) {
    const prefix = files.length > 1 ? `${file.name} (${i + 1}/${files.length}) — ` : "";
    try {
      const { res, osmPromise } = await analyseTrace(file, (msg, frac) => status(prefix + msg, frac));
      const t = { res };
      traces.push(t);
      select(t);
      status("");
      osmPromise.then((feats) => { applyOsm(res, feats); res.osm = "ok"; }, () => { res.osm = "fail"; })
        .then(() => {
          if (!traces.includes(t)) return; // trace effacée entre-temps
          if (t === active) { drawMap(res, false); render(res); }
          renderTraces();
        });
    } catch (e) {
      console.error(e);
      status(`Erreur sur ${file.name} : ${e.message}`, null, true);
    }
  }
  $("file").value = "";
}

const drop = $("drop");
$("file").addEventListener("change", (e) => e.target.files.length && analyseFiles(e.target.files));
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => e.dataTransfer.files.length && analyseFiles(e.dataTransfer.files));
window.addEventListener("resize", () => active && drawProfile(active.res));
// permet de tester sans glisser-déposer : ?gpx=/chemin/servi/fichier.gpx
const q = new URLSearchParams(location.search).get("gpx");
if (q) fetch(q).then((r) => r.blob()).then((b) => analyseFiles([new File([b], q.split("/").pop())]));
