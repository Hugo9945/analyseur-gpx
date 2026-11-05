"use strict";
// Itinéraire « légal » : plus court chemin sur le réseau BD TOPO, en écartant les voies a priori interdites
// aux motos et en préférant les chemins aux routes. S'appuie sur les fonctions de app.js (wfs, pool, dist…).

const RT_TILE = 0.05;        // degrés : taille des tuiles téléchargées
const RT_MAX_KM = 80;        // distance à vol d'oiseau maximale entre A et B
const RT_AUTO_ROUNDS = 1;    // contournement automatique des points d'attention IGN / cadastre, avant de rendre la main
const RT_DETOUR = 1.3;       // rapport longueur réelle / longueur du cercle (les chemins serpentent)
const RT_CANDIDATES = 96;    // boucles essayées (orientations et nombres de points différents), on garde la meilleure
const RT_PRECHECK = 2.6;     // avant une boucle, cadastre vérifié jusqu'à 2,6 fois le rayon du cercle autour de A : sans ça,
const RT_PRECHECK_MAX = 30000; // le générateur fuit les chemins pas encore vérifiés (une sur deux est privée) et prend la route
const RT_LEG = 10000;        // m de boucle par secteur de chemins visé (au moins 4) : plus la boucle est longue, plus elle zigzague
const RT_MAX_ROAD = 0.4;     // part de route au-delà de laquelle une boucle est nettement pénalisée
const RT_SECTOR_MIN = 1500;  // m : longueur minimale d'un secteur de chemins visé par une boucle
const RT_MAX_SCALE = 1.6;    // agrandissement maximal du cercle lors du calibrage (l'emprise chargée en tient compte)
const RT_DUP_MAX = 150;      // m repris au-delà desquels une boucle est écartée si une autre existe (aller-retour)
const RT_REUSE = 30;         // surcoût par mètre d'un tronçon déjà emprunté (l'équivalent de 30 m de chemin) : pas d'aller-retour
                             // tant qu'un autre passage existe, mais pas non plus de détour de dizaines de km pour l'éviter
const RT_PRIV_MIN = 20;      // m en parcelle privée à partir desquels un tronçon est écarté
const RT_EXPL = "chemin d'exploitation"; // tronçon sur la parcelle d'un chemin d'exploitation, écarté sauf case cochée
const RT_FERME = "terrain public fermé"; // camp militaire, forêt domaniale, hôpital, voie ferrée… (voir parcelCat)
const RT_CHECK_ROUNDS = 20;  // vérifications du cadastre (puis recalcul) avant l'analyse complète
const RT_EXPLORE = 8;        // premières vérifications où une boucle peut encore en remplacer une autre ; ensuite on la répare
const RT_PROPS = "geometrie,nature,importance,prive,acces_vehicule_leger,sens_de_circulation,cpx_nature_itineraire_autre,nom_voie_ban_gauche,nom_collaboratif_gauche";
const RT_BANNED_NATURE = new Set(["Sentier", "Escalier", "Piste cyclable", "Bac ou liaison maritime", "Type autoroutier"]);
// coût par mètre d'une route selon son importance (1 = grand axe) ; un chemin vaut 1
const RT_ROAD_FACTOR = { 1: 6, 2: 5, 3: 4, 4: 3, 5: 2.2, 6: 2 };

const bboxStr = ([w, s, e, n]) => `${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`;

// Tronçons de route d'une emprise, par tuiles ; une tuile trop dense est redécoupée
async function fetchNetwork([w, s, e, n], progress) {
  const tiles = [];
  for (let x = w; x < e; x += RT_TILE) for (let y = s; y < n; y += RT_TILE)
    tiles.push([x, y, Math.min(x + RT_TILE, e), Math.min(y + RT_TILE, n)]);
  const out = new Map();
  const load = async (b) => {
    const feats = await wfs("BDTOPO_V3:troncon_de_route", { BBOX: bboxStr(b), PROPERTYNAME: RT_PROPS });
    if (feats.length < 5000) return feats.forEach((f) => out.set(f.id, f));
    const mx = (b[0] + b[2]) / 2, my = (b[1] + b[3]) / 2;
    await Promise.all([[b[0], b[1], mx, my], [mx, b[1], b[2], my], [b[0], my, mx, b[3]], [mx, my, b[2], b[3]]].map(load));
  };
  let done = 0;
  await pool(tiles.map((t) => () => load(t)), 3, () => progress(++done / tiles.length));
  return [...out.values()];
}

// Zones où la moto est interdite (cœur de parc national, réserves, biotopes)
async function fetchStrongZones(bbox) {
  // parc national : seul le cœur compte, filtré après coup ; les autres couches « fortes » le sont entièrement
  const res = await pool(ZONES.filter((z) => z.layer === "patrinat_pn:parc_national" || z.strong({}))
    .map((z) => async () => (await wfs(z.layer, { BBOX: bboxStr(bbox) })).filter((f) => z.strong(f.properties))
      .map((f) => Object.assign(f, { def: z, strong: true }))), 3);
  return res.flat();
}

// Motif d'exclusion d'un tronçon, ou null s'il est a priori ouvert aux motos
function rtBan(p, inZone, mid) {
  if (RT_BANNED_NATURE.has(p.nature)) return p.nature;
  if (p.prive) return "voie privée";
  if (p.acces_vehicule_leger === "Restreint aux ayants droit" || p.acces_vehicule_leger === "Physiquement impossible") return p.acces_vehicule_leger;
  // une route goudronnée reste ouverte dans une zone protégée : sans elle, les ponts sur une rivière classée
  // seraient coupés et la boucle ferait des dizaines de km de détour
  if (["Chemin", "Route empierrée"].includes(p.nature) && inZone(mid).length) return "zone protégée";
  return null;
}

// pref : 0 = plus court, 1 = le plus de chemins possible (une petite route y coûte 13 à 15 fois un chemin :
// là où les chemins autorisés sont en petits morceaux, c'est ce qui fait passer la boucle par eux)
const RT_PREF_GAIN = 12;
function rtFactor(p, pref) {
  const base = p.nature === "Chemin" ? 1 : p.nature === "Route empierrée" ? 1.15 : RT_ROAD_FACTOR[p.importance] || 3;
  return 1 + RT_PREF_GAIN * pref * (base - 1);
}

// Intérêt d'un chemin pour la moto, de 0 à 1 : virages et dénivelé, mesurés sur la géométrie BD TOPO (qui porte
// l'altitude de chaque point), rééchantillonnée tous les RT_RESAMPLE m pour ignorer les petites irrégularités du tracé.
// Un intérêt de 1 : RT_TURN_FULL degrés de virage par km (un virage serré tous les 100 m), ou RT_CLIMB_FULL m de
// montées et descentes par km au-delà de RT_CLIMB_NOISE (les irrégularités du modèle de terrain sur le plat).
const RT_RESAMPLE = 20, RT_TURN_FULL = 800, RT_CLIMB_FULL = 50, RT_CLIMB_NOISE = 10;
const RT_TECH_GAIN = 0.5;   // curseur « Tracé » au maximum : un chemin d'intérêt 1 coûte moitié moins qu'un chemin plat et droit
const RT_TECH_SCORE = 3;    // poids de l'intérêt moyen dans la note d'une boucle
function interest(c, len) {
  if (len < 60) return 0;
  const z = c.every((p) => p.length > 2 && p[2] > -500);
  const pts = [c[0]];
  let acc = 0;
  for (let i = 1; i < c.length; i++) {
    let a = c[i - 1];
    const b = c[i];
    let d = dist(a, b);
    while (acc + d >= RT_RESAMPLE && d > 0) {
      const t = (RT_RESAMPLE - acc) / d;
      a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z ? a[2] + (b[2] - a[2]) * t : 0];
      pts.push(a); d = dist(a, b); acc = 0;
    }
    acc += d;
  }
  pts.push(c.at(-1));
  let turn = 0, climb = 0;
  const head = (p, q) => Math.atan2(q[1] - p[1], (q[0] - p[0]) * Math.cos(p[1] * rad));
  for (let i = 1; i < pts.length - 1; i++) {
    let d = Math.abs(head(pts[i], pts[i + 1]) - head(pts[i - 1], pts[i]));
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > 8 * rad) turn += d / rad; // en deçà de 8°, bruit de numérisation
  }
  if (z) for (let i = 1; i < pts.length; i++) climb += Math.abs(pts[i][2] - pts[i - 1][2]);
  const km = len / 1000;
  return 1 - (1 - Math.min(1, turn / km / RT_TURN_FULL)) * (1 - Math.min(1, Math.max(0, climb / km - RT_CLIMB_NOISE) / RT_CLIMB_FULL));
}
// coût d'un chemin selon le curseur « Tracé » (rt.tech de 0 à 1)
const rtTech = (e) => (e.int ? 1 - RT_TECH_GAIN * (rt.tech || 0) * e.int : 1);

// Part des chemins non contrôlés au cadastre qui s'avèrent publics, par type : a priori, puis apprise au fil des
// contrôles dans le secteur (de 40 à 70 % selon les régions pour un chemin sans nom). Un chemin nommé ou balisé
// en randonnée est presque toujours un chemin rural.
const RT_OK_PRIOR = { nom: 0.85, empierree: 0.65, chemin: 0.45 };
const rtKind = (p) => (p.cpx_nature_itineraire_autre || p.nom_voie_ban_gauche || p.nom_collaboratif_gauche ? "nom"
  : p.nature === "Route empierrée" ? "empierree" : p.nature === "Chemin" ? "chemin" : null);

function rtLearnRates(g) {
  const ok = {}, all = {};
  for (const e of g.edges) {
    const k = e.checked && e.kind;
    if (!k || (e.ban && e.ban !== "parcelle privée" && e.ban !== RT_FERME)) continue;
    all[k] = (all[k] || 0) + e.len;
    if (!e.ban) ok[k] = (ok[k] || 0) + e.len;
  }
  // a priori équivalent à 3 km contrôlés
  g.rates = Object.fromEntries(Object.entries(RT_OK_PRIOR).map(([k, r]) => [k, ((ok[k] || 0) + 3000 * r) / ((all[k] || 0) + 3000)]));
}

// Un chemin non contrôlé coûte un peu plus qu'un chemin vérifié, et compte moins dans le choix d'une boucle
// (rtDoubt² = 1 / probabilité d'être public)
function rtDoubt(e) {
  return e.kind && !e.checked ? 1 / Math.sqrt((rt.net && rt.net.rates || RT_OK_PRIOR)[e.kind]) : 1;
}

// Verdict du cadastre d'un tronçon (motif d'exclusion, ou "" s'il est public), conservé quand le réseau
// est rechargé pour une autre emprise
const edgeKey = (e) => `${e.f.id}@${e.coords[0]}`;

function buildGraph(feats, zones) {
  const inZone = polyIndex(zones, true);
  const ids = new Map(), xy = [], adj = [];
  const node = (c) => {
    const k = c[0].toFixed(7) + "," + c[1].toFixed(7);
    let i = ids.get(k);
    if (i == null) { i = xy.length; ids.set(k, i); xy.push([c[0], c[1]]); adj.push([]); }
    return i;
  };
  const edges = [];
  for (const f of feats) for (const part of lineParts(f.geometry)) {
    if (part.length < 2) continue;
    let len = 0;
    for (let i = 1; i < part.length; i++) len += dist(part[i - 1], part[i]);
    const mid = part[part.length >> 1];
    const e = { f, coords: part, len, mid, ban: rtBan(f.properties, inZone, mid), kind: rtKind(f.properties) };
    if (["Chemin", "Route empierrée"].includes(f.properties.nature)) e.int = interest(part, len);
    const v = rt.verdict.get(edgeKey(e));
    if (v) {
      e.checked = true; e.ban = e.ban || v.ban; e.why = v.why; e.expl = v.expl;
      if (e.expl && !e.ban && !$("rt-expl").checked) e.ban = RT_EXPL;
    }
    const a = node(part[0]), b = node(part.at(-1));
    e.a = a; e.b = b;
    edges.push(e);
    const sens = f.properties.sens_de_circulation;
    if (sens !== "Sens inverse") adj[a].push({ to: b, e, fwd: true });
    if (sens !== "Sens direct") adj[b].push({ to: a, e, fwd: false });
  }
  return { xy, adj, edges };
}

// Tas binaire minimal pour A*
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// Nœuds reliés à « from » par des voies autorisées (en ignorant les sens uniques)
function reachable(g, from, avoid) {
  const seen = new Uint8Array(g.xy.length), stack = [from];
  seen[from] = 1;
  while (stack.length) {
    const u = stack.pop();
    for (const s of g.adj[u]) {
      if (s.e.ban || avoid.has(s.e)) continue;
      for (const v of [s.e.a, s.e.b]) if (!seen[v]) { seen[v] = 1; stack.push(v); }
    }
  }
  return seen;
}

// Nœud du réseau autorisé le plus proche d'un point [lon, lat], éventuellement parmi ceux d'un masque
function nearestNode(g, p, avoid, mask) {
  let best = -1, bd = Infinity;
  g.adj.forEach((out, i) => {
    if (mask && !mask[i]) return;
    if (!out.some((s) => !s.e.ban && !avoid.has(s.e))) return;
    const d = dist(g.xy[i], p);
    if (d < bd) { bd = d; best = i; }
  });
  return { i: best, d: bd };
}

// A* : renvoie la liste des coordonnées [lon, lat], les tronçons empruntés et le coût, ou null
// (aussi quand le coût dépasserait maxCost : la recherche s'arrête sans parcourir tout le réseau)
function shortestPath(g, from, to, pref, avoid, used = new Set(), maxCost = Infinity) {
  const n = g.xy.length, cost = new Float64Array(n).fill(Infinity), prev = new Array(n);
  // admissible : aucun tronçon ne coûte moins de 1 par mètre (moins le gain du curseur « Tracé »)
  const goal = g.xy[to], hk = 1 - RT_TECH_GAIN * (rt.tech || 0), h = (i) => hk * dist(g.xy[i], goal);
  const heap = new Heap();
  cost[from] = 0; heap.push(h(from), from);
  while (heap.size && heap.k[0] <= maxCost) {
    const u = heap.pop();
    if (u === to) break;
    for (const s of g.adj[u]) {
      if (s.e.ban || avoid.has(s.e)) continue;
      const c = cost[u] + s.e.len * (rtFactor(s.e.f.properties, pref) * rtDoubt(s.e) * rtTech(s.e) + (used.has(s.e) ? RT_REUSE : 0));
      if (c < cost[s.to]) { cost[s.to] = c; prev[s.to] = s; heap.push(c + h(s.to), s.to); }
    }
  }
  if (cost[to] === Infinity || cost[to] > maxCost) return null;
  const steps = [];
  for (let v = to; v !== from; v = steps.at(-1).from) { const s = prev[v]; steps.push({ ...s, from: s.fwd ? s.e.a : s.e.b }); }
  steps.reverse();
  const coords = [g.xy[from]];
  const segs = steps.map((s) => (s.fwd ? s.e.coords : [...s.e.coords].reverse()));
  for (const c of segs) coords.push(...c.slice(1).map((p) => [p[0], p[1]]));
  return { coords, edges: steps.map((s) => s.e), segs, cost: cost[to] };
}

// extra : autres traces du fichier, { nom: lignes } (les vides sont omises)
function toGpx(name, lines, extra = {}) {
  const pt = (p) => `<trkpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}"${p[2] != null ? `><ele>${p[2].toFixed(1)}</ele></trkpt>` : "/>"}`;
  const trk = ([n, ls]) => `<trk><name>${esc(n)}</name>${ls.map((l) => `<trkseg>${l.map(pt).join("")}</trkseg>`).join("")}</trk>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Analyseur de traces GPX" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    [[name, lines], ...Object.entries(extra).filter(([, ls]) => ls.length)].map(trk).join("") + `</gpx>\n`;
}

// ---------- Roadbook : une case (waypoint) par bifurcation, lisible dans DMD2, Rally Navigator, OsmAnd… ----------
const RB_NEAR = 12;    // m : la trace passe par un nœud IGN où se croisent au moins 3 tronçons
const RB_ARM = 30;     // m : directions d'arrivée et de départ mesurées 30 m avant et après
const RB_MERGE = 40;   // m : carrefours plus proches fusionnés en une case (ronds-points, carrefours doubles)
const RB_STRAIGHT = 20, RB_FORK = 40; // « tout droit » gardé seulement si une autre voie part à moins de 40° de la nôtre
const RB_WARN = { prive: "privé", ferme: "terrain fermé", ayantsdroit: "ayants droit", osm: "interdit OSM", sentier: "sentier", zone: "zone protégée" };
const bearing = (a, b) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * rad), b[1] - a[1]) / rad + 360) % 360;
const turnOf = (from, to) => ((to - from + 540) % 360) - 180; // > 0 : à droite

function rbNodes(roads) {
  const nodes = new Map();
  for (const f of roads) {
    const g = f.geometry;
    if (!g) continue;
    for (const l of g.type === "MultiLineString" ? g.coordinates : [g.coordinates]) {
      if (l.length < 2) continue;
      for (const [end, dir] of [[0, 1], [l.length - 1, -1]]) {
        let i = end, d = 0;
        while (i + dir >= 0 && i + dir < l.length && d < 15) { d += dist(l[i], l[i + dir]); i += dir; }
        const k = `${l[end][0].toFixed(6)},${l[end][1].toFixed(6)}`;
        const n = nodes.get(k) || nodes.set(k, { p: l[end], arms: [] }).get(k);
        n.arms.push({ b: bearing(l[end], l[i]), f });
      }
    }
  }
  return [...nodes.values()].filter((n) => n.arms.length >= 3);
}

// Point de la trace à RB_ARM m d'un nœud, en remontant (dir -1) ou en avançant (dir 1) depuis l'échantillon i
function rbArm(S, i, p, dir) {
  for (let j = i; j >= 0 && j < S.length && S[j].line === S[i].line; j += dir) if (dist(S[j].p, p) >= RB_ARM) return j;
  return -1;
}

function turnText(t) {
  const a = Math.abs(t), side = t > 0 ? "droite" : "gauche";
  return a < RB_STRAIGHT ? ["Tout droit", "↑"] : a < 60 ? [`Légèrement à ${side}`, t > 0 ? "↗" : "↖"]
    : a < 120 ? [`À ${side}`, t > 0 ? "→" : "←"] : [`Serré à ${side}`, t > 0 ? "↘" : "↙"];
}

function roadbook(S, roads) {
  const nodes = rbNodes(roads), C = 0.0005, grid = new Map();
  const cell = (x, y) => `${x}:${y}`;
  for (const n of nodes) {
    const c = cell(Math.floor(n.p[0] / C), Math.floor(n.p[1] / C));
    (grid.get(c) || grid.set(c, []).get(c)).push(n);
  }
  // passages de la trace près des nœuds (un nœud peut être franchi deux fois sur une boucle)
  const hits = [], last = new Map();
  S.forEach((s, i) => {
    const x = Math.floor(s.p[0] / C), y = Math.floor(s.p[1] / C);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const n of grid.get(cell(x + dx, y + dy)) || []) {
      const d = dist(s.p, n.p);
      if (d > RB_NEAR) continue;
      const h = last.get(n);
      if (h && i - h.i2 <= 3) { h.i2 = i; if (d < h.d) { h.d = d; h.i = i; } }
      else { const nh = { n, i, i2: i, d }; last.set(n, nh); hits.push(nh); }
    }
  });
  hits.sort((a, b) => a.i - b.i);
  const groups = [];
  for (const h of hits) {
    const g = groups.at(-1);
    if (g && S[h.i].line === S[g.at(-1).i].line && S[h.i].at - S[g.at(-1).i].at < RB_MERGE) g.push(h); else groups.push([h]);
  }

  const cases = [];
  for (const g of groups) {
    const first = g[0], lastH = g.at(-1);
    const jb = rbArm(S, first.i, first.n.p, -1), ja = rbArm(S, lastH.i, lastH.n.p, 1);
    if (jb < 0 || ja < 0) continue;
    const bin = bearing(S[jb].p, first.n.p), bout = bearing(lastH.n.p, S[ja].p);
    const turn = turnOf(bin, bout);
    // voies qui partent ailleurs que par où la trace arrive et repart, à chaque nœud du carrefour
    const others = [];
    for (const h of g) {
      const back = bearing(h.n.p, S[Math.max(rbArm(S, h.i, h.n.p, -1), 0)].p), fwd = bearing(h.n.p, S[Math.max(rbArm(S, h.i, h.n.p, 1), 0)].p);
      const arms = h.n.arms.slice();
      for (const target of [back, fwd]) {
        let k = -1, best = 1e9;
        arms.forEach((a, m) => { const d = Math.abs(turnOf(a.b, target)); if (d < best) { best = d; k = m; } });
        if (k >= 0 && best < 60) arms.splice(k, 1);
      }
      others.push(...arms);
    }
    if (!others.length) continue;
    const fork = others.some((a) => Math.abs(turnOf(a.b, bout)) < RB_FORK);
    if (Math.abs(turn) < RB_STRAIGHT && !fork) {
      // tout droit sans ambiguïté : case seulement si on traverse une route départementale ou nationale
      if (!others.some((a) => a.f.properties.cpx_numero && a.f.properties.nature !== "Chemin")) continue;
    }
    const sIn = S[jb], sOut = S[Math.min(ja + 2, S.length - 1)];
    const pOut = sOut.road && sOut.road.properties;
    const [txt, arrow] = turnText(turn);
    const notes = [];
    if (g.some((h) => h.n.arms.some((a) => a.f.properties.nature === "Rond-point"))) notes.push("rond-point");
    if (fork && Math.abs(turn) < 60) notes.push("bifurcation, bien prendre la bonne branche");
    const crossed = others.map((a) => a.f.properties.cpx_numero).find((r) => r && (!pOut || pOut.cpx_numero !== r));
    if (crossed && Math.abs(turn) < RB_STRAIGHT) notes.push(`traverser la ${crossed}, prudence`);
    const name = pOut && (pOut.cpx_numero || pOut.nom_voie_ban_gauche || pOut.nom_collaboratif_gauche);
    const paved = (s) => s.voie === "revetue" || s.voie === "cyclable";
    const kind = !pOut ? null : paved(sOut) ? (paved(sIn) ? "route" : "reprendre le goudron") : pOut.nature === "Chemin" ? "chemin de terre" : "chemin empierré";
    if (kind) notes.push(`${kind}${name ? ` « ${name} »` : ""}${!paved(sOut) && paved(sIn) ? " (fin du goudron)" : ""}`);
    const round = g.some((h) => h.n.arms.some((a) => a.f.properties.nature === "Rond-point"));
    cases.push({ i: first.i, p: first.n.p, at: S[first.i].at, txt, arrow, notes, turn, round, inPaved: paved(sIn), outPaved: paved(sOut),
      arms: others.map((a) => ({ t: turnOf(bin, a.b), dirt: ["Chemin", "Route empierrée"].includes(a.f.properties.nature) })) });
  }

  // points d'attention et fortes pentes jusqu'à la case suivante
  cases.forEach((c, k) => {
    const end = k + 1 < cases.length ? cases[k + 1].i : S.length;
    const warn = new Set();
    let steep = 0;
    for (let j = c.i; j < end; j++) {
      for (const r of S[j].reasons || []) if (RB_WARN[r]) warn.add(RB_WARN[r]);
      const b = S[j + 3]; // pente sur 30 m : le relief, pas le bruit de l'altitude
      if (b && b.line === S[j].line && S[j].z != null && b.z != null) steep = Math.max(steep, Math.abs(b.z - S[j].z) / Math.max(1, b.at - S[j].at));
    }
    if (warn.size) c.notes.push(`⚠ ${[...warn].join(", ")} avant la case suivante`);
    if (steep >= 0.15) c.notes.push(`pente jusqu'à ${Math.round(steep * 100)} %`);
  });
  return cases;
}

const km1 = (m) => (m / 1000).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const km2 = (m) => (m / 1000).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function roadbookGpx(name, S, cases) {
  const base = S[0].at - S[0].len / 2; // section isolée : kilométrage depuis son début
  const wpt = (p, n, d) => `<wpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}"><name>${esc(n)}</name><cmt>${esc(d)}</cmt><desc>${esc(d)}</desc><sym>Waypoint</sym></wpt>\n`;
  let prev = 0;
  cases = cases.map((c) => ({ ...c, at: c.at - base }));
  const w = [wpt(S[0].p, `0,0 Départ`, "Départ (km 0)")];
  cases.forEach((c, k) => {
    const d = `Case ${k + 1} · km ${km2(c.at)} (+${km2(c.at - prev)}) · ${c.txt}${c.notes.length ? " · " + c.notes.join(" · ") : ""}`;
    w.push(wpt(c.p, `${km1(c.at)} ${c.arrow} ${c.txt}`, d));
    prev = c.at;
  });
  const end = S.at(-1);
  const fin = end.at + end.len / 2 - base;
  w.push(wpt(end.p, `${km1(fin)} Arrivée`, `Arrivée · km ${km2(fin)} (+${km2(fin - prev)})`));
  const lines = [];
  for (const s of S) { if (!lines.length || lines.at(-1).line !== s.line) lines.push({ line: s.line, pts: [] }); lines.at(-1).pts.push(s); }
  const pt = (s) => `<trkpt lat="${s.p[1].toFixed(6)}" lon="${s.p[0].toFixed(6)}">${s.z != null ? `<ele>${s.z.toFixed(1)}</ele>` : ""}</trkpt>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Analyseur de traces GPX" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    w.join("") + `<trk><name>${esc(name)}</name>${lines.map((l) => `<trkseg>${l.pts.map(pt).join("")}</trkseg>`).join("")}</trk>\n</gpx>\n`;
}

// Dessin « tulipe » d'une case : on arrive par le bas, trait plein = goudron, tirets = chemin
function tulip(c) {
  const cx = 50, cy = 54, R = 40;
  const pt = (t, r) => [cx + r * Math.sin(t * rad), cy - r * Math.cos(t * rad)].map((v) => v.toFixed(1));
  const line = (x2, y2, w, color, dirt) => `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"${dirt ? ` stroke-dasharray="${w + 2} ${w}"` : ""}/>`;
  let s = "";
  for (const a of c.arms) s += line(...pt(a.t, 32), a.dirt ? 3 : 5, "#9a9a9a", a.dirt);
  if (c.round) s += `<circle cx="${cx}" cy="${cy}" r="9" fill="#fff" stroke="#9a9a9a" stroke-width="4"/>`;
  s += line(cx, cy + R, 6, "#111", !c.inPaved) + `<circle cx="${cx}" cy="${cy + R}" r="6" fill="#111"/>`;
  const [ex, ey] = pt(c.turn, R).map(Number);
  const head = (t) => `${(ex + 13 * Math.sin(t * rad)).toFixed(1)},${(ey - 13 * Math.cos(t * rad)).toFixed(1)}`;
  s += line(...pt(c.turn, R - 8), 6, "#111", !c.outPaved) +
    `<polygon points="${ex},${ey} ${head(c.turn + 150)} ${head(c.turn - 150)}" fill="#111"/>`;
  return `<svg viewBox="0 0 100 100" width="110" height="110">${s}</svg>`;
}

// Roadbook à imprimer : une page HTML ouverte dans un nouvel onglet, impression lancée (« Enregistrer en PDF »)
function roadbookPage(name, S, cases, elev) {
  const base = S[0].at - S[0].len / 2, end = S.at(-1), fin = end.at + end.len / 2 - base;
  let prev = 0;
  const rows = cases.map((c, k) => {
    const at = c.at - base, part = at - prev;
    prev = at;
    const warn = c.notes.filter((n) => n.startsWith("⚠") || n.startsWith("pente") || n.startsWith("traverser"));
    const info = c.notes.filter((n) => !warn.includes(n));
    return `<tr><td class="n">${k + 1}</td><td class="km"><b>${km2(at)}</b><span>+${km2(part)}</span></td><td class="tu">${tulip(c)}</td>` +
      `<td class="tx"><b>${esc(c.txt)}</b>${info.map((n) => `<div>${esc(n)}</div>`).join("")}${warn.map((n) => `<div class="w">${esc(n)}</div>`).join("")}</td></tr>`;
  }).join("");
  const dplus = elev ? ` · D+ ${Math.round(elev.up)} m` : "";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(name)}</title><style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font: 13px/1.35 -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; margin: 0 auto; max-width: 180mm; }
  h1 { font-size: 18px; margin: 0 0 2px; } .sub { color: #555; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; } tr { break-inside: avoid; }
  td { border: 1.5px solid #111; padding: 4px 8px; vertical-align: middle; }
  .n { width: 26px; text-align: center; color: #555; } .km { width: 74px; text-align: right; }
  .km b { display: block; font-size: 20px; } .km span { color: #555; }
  .tu { width: 112px; padding: 0; text-align: center; } .tx b { font-size: 15px; } .tx div { margin-top: 2px; }
  .w { font-weight: 600; color: #b3261e; } .leg { color: #555; font-size: 11px; margin: 6px 0 10px; }
  @media screen { body { padding: 16px; } .bar { position: sticky; top: 0; background: #fff; padding: 8px 0; } }
  @media print { .bar { display: none; } }
  </style></head><body>
  <div class="bar"><button onclick="print()">Imprimer ou enregistrer en PDF</button></div>
  <h1>${esc(name)}</h1><div class="sub">${km1(fin)} km${dplus} · ${cases.length} cases · ${new Date().toLocaleDateString("fr-FR")}</div>
  <div class="leg">On arrive par le point noir, en bas. Trait plein : goudron ; tirets : chemin. Gris : voies qu'on ne prend pas. km : total depuis le départ, puis distance depuis la case précédente.</div>
  <table><tr><td class="n">D</td><td class="km"><b>0,00</b></td><td class="tu"></td><td class="tx"><b>Départ</b></td></tr>${rows}
  <tr><td class="n">A</td><td class="km"><b>${km2(fin)}</b><span>+${km2(fin - prev)}</span></td><td class="tu"></td><td class="tx"><b>Arrivée</b></td></tr></table>
  <script>addEventListener("load", () => setTimeout(print, 300));<\/script></body></html>`;
}

function saveGpx(name, lines, extra) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([toGpx(name, lines, extra)], { type: "application/gpx+xml" }));
  a.download = `${name}.gpx`; a.click();
}

// Enchaîne les plus courts chemins entre des nœuds successifs ; un tronçon déjà parcouru coûte plus cher.
// blocks[i] : ensembles de tronçons à ne pas emprunter pour atteindre nodes[i], si un autre passage existe.
function chainPath(g, nodes, pref, blocks = []) {
  const used = new Set(), coords = [], edges = [];
  let first = null, lastFrom = 0; // tronçons de la première étape, début de la dernière
  for (let i = 1; i < nodes.length; i++) {
    let p = shortestPath(g, nodes[i - 1], nodes[i], pref, rt.avoid, used);
    if (!p) return null;
    // sans les tronçons bloqués, si le détour ne coûte pas plus de 3 fois le passage direct
    const blk = blocks[i];
    if (blk && blk.length) p = shortestPath(g, nodes[i - 1], nodes[i], pref, { has: (e) => rt.avoid.has(e) || blk.some((b) => b.has(e)) }, used, 3 * p.cost) || p;
    coords.push(...(coords.length ? p.coords.slice(1) : p.coords));
    if (i === nodes.length - 1) lastFrom = edges.length;
    for (const e of p.edges) { edges.push(e); used.add(e); }
    if (i === 1) first = new Set(p.edges);
  }
  const seen = new Set();
  let dup = 0, stem = 0;
  for (const e of edges) if (seen.has(e)) dup += e.len; else seen.add(e);
  // départ au fond d'une impasse : ce que la dernière étape reprend de la première près de A est inévitable
  // (limité au premier kilomètre autour du départ : au-delà, c'est un vrai aller-retour)
  if (nodes.length > 2 && nodes[0] === nodes.at(-1)) for (let k = lastFrom; k < edges.length; k++) {
    const e = edges[k];
    if (first.has(e) && dist(e.mid, g.xy[nodes[0]]) < 1000) stem += e.len;
  }
  return { coords, edges, len: edges.reduce((a, e) => a + e.len, 0), dup: dup - stem };
}

// Vérifie le cadastre de tronçons pas encore contrôlés et écarte ceux qui traversent une parcelle privée.
// strict : compte aussi les passages à moins de EDGE_TOL m d'une limite de parcelle (souvent un chemin rural
// mal calé sur le cadastre, mais parfois un chemin d'exploitation privé). Les tronçons sont envoyés par lots
// (MULTILINESTRING d'au plus CHUNK points), dans l'ordre reçu : mieux vaut des voisins d'un même lot.
// Renvoie le nombre de tronçons écartés, et failed si une partie des requêtes a échoué : les tronçons de ces
// lots sans parcelle privée trouvée restent à contrôler.
async function checkEdges(list, strict, progress = () => {}) {
  const todo = [...new Set(list)].filter((e) => !e.checked && !e.ban);
  if (!todo.length) return { n: 0 };
  const lots = [[]];
  let pts = 0;
  for (const e of todo) {
    if (pts + e.coords.length > CHUNK && lots.at(-1).length) { lots.push([]); pts = 0; }
    lots.at(-1).push(e); pts += e.coords.length;
  }
  const found = new Map(), lost = new Set(); // tronçons des lots dont la requête a échoué
  let done = 0;
  for (const feats of await pool(lots.map((l) => () => {
    const geom = `MULTILINESTRING(${l.map((e) => `(${coords(e.coords.length > CHUNK ? e.coords.filter((c, i, a) => i % Math.ceil(a.length / CHUNK) === 0 || i === a.length - 1) : e.coords)})`).join(",")})`;
    return wfs("CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle", { CQL_FILTER: `DWITHIN(geom,${geom},8,meters)` })
      .catch((err) => { console.warn("cadastre", err); l.forEach((e) => lost.add(e)); return []; });
  }), 3, () => progress(++done / lots.length)))
    for (const f of feats) found.set(f.id, f);
  const parcels = [...found.values()];
  const owners = await fetchOwners([...new Set(parcels.map((f) => f.properties.idu))]);
  const inParcel = polyIndex(parcels);
  let n = 0;
  for (const e of todo) {
    // why : longueur par catégorie (noncad, public, limite, prive) et parcelle la plus parcourue de la catégorie
    // retenue, pour expliquer le verdict sur la carte des chemins publics
    const m = { noncad: 0, public: 0, limite: 0, prive: 0, joint: 0, exploit: 0, ferme: 0 }, top = {};
    for (let j = 1; j < e.coords.length; j++) {
      const a = e.coords[j - 1], b = e.coords[j], d = dist(a, b), k = Math.max(1, Math.ceil(d / STEP));
      for (let i = 0; i < k; i++) {
        const t = (i + 0.5) / k, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], f = inParcel(p);
        let c = f ? parcelCat(f, owners) : "noncad";
        if ((c === "particulier" || c === "pmprivee") && exploitParcel(f, owners)) c = "exploit";
        else if (c === "particulier" || c === "pmprivee" || c === "ferme") {
          const near = !strict && boundaryDist(p, f) < EDGE_TOL;
          c = near && gapBeside(p, a, b, inParcel, owners) ? "limite" : c === "ferme" ? "ferme" : "prive";
          if (near && c === "prive") m.joint += d / k; // le long d'une limite entre parcelles privées jointives
        } else if (c !== "noncad") c = "public";
        m[c] += d / k;
        if (f) ((top[c] ||= new Map()).set(f, (top[c].get(f) || 0) + d / k));
      }
    }
    const priv = m.prive + m.ferme;
    // surtout sur la parcelle d'un chemin d'exploitation : ses bouts « en limite » sans bande non cadastrée
    // (carrefours, décalages) comptent avec elle ; une vraie traversée de parcelle privée l'écarte quand même
    const expl = (m.exploit >= RT_PRIV_MIN || m.exploit > e.len / 2) && m.exploit >= priv && priv - m.joint < RT_PRIV_MIN;
    if (!expl && (priv >= RT_PRIV_MIN || priv > e.len / 2)) { e.ban = m.ferme > m.prive ? RT_FERME : "parcelle privée"; n++; }
    else if (expl) {
      e.expl = true;
      if (!$("rt-expl").checked) { e.ban = RT_EXPL; n++; }
    }
    const main = e.ban === "parcelle privée" ? "prive" : e.ban === RT_FERME ? "ferme" : e.expl ? "exploit" : ["public", "limite", "noncad"].reduce((x, y) => (m[y] > m[x] ? y : x));
    const f = top[main] && [...top[main]].sort((x, y) => y[1] - x[1])[0][0];
    e.why = { m, main, f, o: f && owners[f.properties.idu] };
    if (e.ban || !lost.has(e)) {
      e.checked = true;
      rt.verdict.set(edgeKey(e), { ban: e.ban === RT_EXPL ? null : e.ban, expl: e.expl, why: e.why });
    }
  }
  rtLearnRates(rt.net);
  return { n, failed: lost.size > 0 };
}

// Point à d mètres de p dans la direction ang (radians, 0 = nord)
function offset(p, d, ang) {
  return [p[0] + (d * Math.sin(ang)) / (111320 * Math.cos(p[1] * rad)), p[1] + (d * Math.cos(ang)) / 111320];
}

// Composante principale du réseau autorisé (en ignorant les sens uniques) : marque les nœuds qui en font partie,
// pour ne jamais partir d'un îlot de voies autorisées cerné de chemins privés
function mainComponent(g, avoid) {
  const label = new Int32Array(g.xy.length).fill(-1), stack = [];
  let best = -1, bestSize = 0;
  for (let i = 0; i < g.xy.length; i++) {
    if (label[i] >= 0) continue;
    let size = 0;
    label[i] = i; stack.push(i);
    while (stack.length) {
      const u = stack.pop();
      size++;
      for (const s of g.adj[u]) {
        if (s.e.ban || avoid.has(s.e)) continue;
        for (const v of [s.e.a, s.e.b]) if (label[v] < 0) { label[v] = i; stack.push(v); }
      }
    }
    if (size > bestSize) { best = i; bestSize = size; }
  }
  return Uint8Array.from(label, (l) => (l === best ? 1 : 0));
}

const isDirt = (e) => ["Chemin", "Route empierrée"].includes(e.f.properties.nature);
const dirtShare = (p) => p.edges.reduce((a, e) => a + (isDirt(e) ? e.len : 0), 0) / p.len;
// part de chemins attendue une fois le cadastre vérifié : un chemin non contrôlé compte selon sa chance d'être public
const dirtExpected = (p) => p.edges.reduce((a, e) => a + (isDirt(e) ? e.len / rtDoubt(e) ** 2 : 0), 0) / p.len;

// Secteurs de chemins : morceaux d'un seul tenant du réseau de chemins autorisés (hors impasses : masque ok).
// Pour chacun, sa plus longue traversée entre deux portes, des nœuds où il rejoint une route (masque gate) : la
// boucle y entre par une route et en ressort par une autre, sans revenir sur ses pas.
// Les chemins pas encore contrôlés au cadastre comptent selon leur chance d'être publics.
function dirtSectors(g, ok, gate) {
  const par = new Map(), find = (x) => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
  const es = g.edges.filter((e) => !e.ban && !rt.avoid.has(e) && isDirt(e) && ok[e.a] && ok[e.b]);
  for (const e of es) {
    for (const v of [e.a, e.b]) if (!par.has(v)) par.set(v, v);
    par.set(find(e.a), find(e.b));
  }
  const len = new Map(), seed = new Map(), own = new Map();
  for (const e of es) {
    const r = find(e.a);
    len.set(r, (len.get(r) || 0) + e.len); seed.set(r, e.a);
    (own.get(r) || own.set(r, new Set()).get(r)).add(e);
  }
  // nœud le plus éloigné de « from » en chemins (en mètres « attendus publics »), et la distance correspondante
  const far = (from) => {
    const d = new Map([[from, 0]]), done = new Set(), heap = new Heap();
    heap.push(0, from);
    let best = from;
    while (heap.size) {
      const u = heap.pop();
      if (done.has(u)) continue;
      done.add(u);
      if (gate[u] && (!gate[best] || d.get(u) > d.get(best))) best = u;
      for (const s of g.adj[u]) {
        if (s.e.ban || rt.avoid.has(s.e) || !isDirt(s.e)) continue;
        const dv = d.get(u) + s.e.len / rtDoubt(s.e) ** 2;
        if (dv < (d.get(s.to) ?? Infinity)) { d.set(s.to, dv); heap.push(dv, s.to); }
      }
    }
    return [best, d.get(best)];
  };
  const out = [];
  for (const [r, l] of len) {
    if (l < RT_SECTOR_MIN) continue;
    const [u] = far(seed.get(r)), [v, t] = far(u);
    // intérêt moyen du secteur (virages, dénivelé), pondéré par la longueur
    const es = own.get(r), int = [...es].reduce((x, e) => x + e.len * (e.int || 0), 0) / l;
    if (u !== v && gate[u] && gate[v]) out.push({ u, v, t, int, pu: g.xy[u], pv: g.xy[v], es });
  }
  return out;
}

// Une boucle : cercle passant par A, orienté selon theta. Près de chacun des n points du cercle, on choisit le
// secteur de chemins qui offre la plus longue traversée, et la boucle le traverse d'un bout à l'autre ; faute de
// secteur, le point est recalé sur le croisement le plus proche. Le rayon est corrigé jusqu'à ce que la longueur
// réelle soit à 7 % de la cible.
// score : note d'une boucle (la plus haute gagne) ; parmi les essais du calibrage, on garde la mieux notée
function loopCandidate(g, start, a, sectors, cross, target, pref, theta, n, scale, score) {
  let best = null;
  for (let k = 0; k < 7; k++) {
    // rayon de recherche des secteurs fixe : un cercle rétréci par le calibrage doit encore les atteindre
    const r = (scale * target) / (2 * Math.PI * RT_DETOUR), c = offset(a, r, theta), rs = (0.4 * target) / (RT_DETOUR * n);
    // on rejoint un secteur et on en repart par la route, pas par ses propres chemins (aller-retour)
    const nodes = [start], blocks = [], used = new Set();
    let after = null;
    for (let i = 1; i < n; i++) {
      const p = offset(c, r, theta + Math.PI + (2 * Math.PI * i) / n);
      let bs = 0, sec = null;
      if (pref) for (const z of sectors) {
        if (used.has(z)) continue;
        const d = Math.min(dist(z.pu, p), dist(z.pv, p)), sc = z.t * (1 + (rt.tech || 0) * z.int) * (1 - (0.5 * d) / rs);
        if (d <= rs && sc > bs) { bs = sc; sec = z; }
      }
      if (!sec) {
        const q = nearestNode(g, p, rt.avoid, cross).i;
        if (q >= 0) { blocks[nodes.length] = [after].filter(Boolean); after = null; nodes.push(q); }
        continue;
      }
      used.add(sec);
      // entrée par le bout le plus proche du point précédent
      const prev = g.xy[nodes.at(-1)];
      blocks[nodes.length] = [after, sec.es].filter(Boolean);
      nodes.push(...(dist(sec.pu, prev) <= dist(sec.pv, prev) ? [sec.u, sec.v] : [sec.v, sec.u]));
      after = sec.es;
    }
    blocks[nodes.length] = [after].filter(Boolean);
    nodes.push(start);
    const path = chainPath(g, nodes, pref, blocks);
    if (!path) break;
    const l = { path, theta, n, scale };
    l.score = score(l);
    if (!best || l.score > best.score) best = l;
    if (Math.abs(path.len / target - 1) < 0.07) break;
    scale = Math.min(RT_MAX_SCALE, Math.max(0.3, scale * target / path.len));
  }
  return best;
}

// Choisit la boucle qui a le plus de chemins à la bonne distance parmi RT_CANDIDATES orientations.
// Après quelques contrôles du cadastre, on garde la même boucle et on la répare (prev) : en changer ferait
// découvrir à chaque fois de nouveaux chemins non vérifiés, dont la moitié peut être privée.
async function planLoop(g, a, target, pref, seed, prev, progress = () => {}) {
  const mask = mainComponent(g, rt.avoid);
  const start = nearestNode(g, a, rt.avoid, mask).i;
  if (start < 0) return null;
  // points de passage sur des croisements (3 voies autorisées ou plus), jamais au fond d'une impasse
  // où la boucle entrerait et ressortirait par le même chemin
  const deg = mask.map((m, i) => (m ? new Set(g.adj[i].filter((s) => !s.e.ban && !rt.avoid.has(s.e)).map((s) => s.e)).size : 0));
  const cross = deg.map((d) => (d >= 3 ? 1 : 0));
  const gate = deg.map((d, i) => (d && g.adj[i].some((s) => !s.e.ban && !rt.avoid.has(s.e) && !isDirt(s.e)) ? 1 : 0));
  const sectors = pref ? dirtSectors(g, deg.map((d) => (d >= 2 ? 1 : 0)), gate) : [];
  // le plus de chemins (et pas plus de RT_MAX_ROAD de route), la bonne distance, pas d'aller-retour sur un même bout
  // intérêt moyen de la boucle (chemins seulement, routes à 0), compté si le curseur « Tracé » le demande
  const fun = (p) => p.edges.reduce((x, e) => x + e.len * (e.int || 0), 0) / p.len;
  const score = (l, d = dirtExpected(l.path)) => (pref ? d - 3 * Math.max(0, 1 - d - RT_MAX_ROAD) : 0) + RT_TECH_SCORE * (rt.tech || 0) * fun(l.path)
    - 2 * Math.abs(l.path.len / target - 1) - 8 * Math.max(0, Math.abs(l.path.len / target - 1) - 0.1) - 10 * l.path.dup / l.path.len - (l.path.dup >= RT_DUP_MAX ? 1 : 0);
  // la boucle réparée est gardée tant qu'elle reste à 10 % de la distance visée, sans aller-retour
  const fixed = prev && loopCandidate(g, start, a, sectors, cross, target, pref, prev.theta, prev.n, prev.scale, score);
  if (fixed && Math.abs(fixed.path.len / target - 1) <= 0.1 && fixed.path.dup < RT_DUP_MAX) return fixed;
  const n = Math.max(4, Math.round(target / RT_LEG));
  let best = fixed || null;
  for (let i = 0; i < RT_CANDIDATES; i++) {
    // le calcul est long : la page reste réactive et la barre avance
    if (i % 4 === 0) { progress(i / RT_CANDIDATES); await new Promise((r) => setTimeout(r)); }
    const l = loopCandidate(g, start, a, sectors, cross, target, pref, seed + (2 * Math.PI * i) / RT_CANDIDATES, Math.max(3, n - 3 + (i % 5)), 1, score);
    if (l && (!best || l.score > best.score)) best = l;
  }
  return best;
}

// ---------- Interface ----------
const rt = { mode: "ab", a: null, b: null, pick: null, net: null, netBox: null, avoid: new Set(), verdict: new Map(),
  loop: null, via: null, seed: Math.random() * 2 * Math.PI, trace: null, markers: L.layerGroup().addTo(map),
  scan: null, scanLayer: L.layerGroup().addTo(map) };

function rtDraw() {
  rt.markers.clearLayers();
  const loop = rt.mode === "loop";
  if (rt.c) L.marker([rt.c[1], rt.c[0]], { icon: L.divIcon({ className: "pin pin-cp", html: "", iconSize: [18, 18] }), interactive: false, zIndexOffset: 900 }).addTo(rt.markers);
  $("cp-pick").textContent = rt.pick === "c" ? "Touche la carte…" : rt.c ? "Déplacer le centre" : "Placer le centre";
  $("cp-pick").classList.toggle("on", rt.pick === "c");
  $("cp-go").disabled = (rt.busy && !rt.scanning) || !rt.c;
  $("cp-go").textContent = rt.scanning ? "Arrêter la vérification" : `Afficher les chemins à ${$("cp-km").value} km`;
  $("cp-clear").hidden = !rt.scan || rt.scanning;
  for (const k of ["a", "b"]) {
    if (rt[k] && (k === "a" || !loop)) L.marker([rt[k][1], rt[k][0]], { icon: L.divIcon({ className: "pin pin-rt", html: k.toUpperCase(), iconSize: [24, 24] }), interactive: false, zIndexOffset: 1000 }).addTo(rt.markers);
    $(`rt-${k}`).textContent = rt.pick === k ? "Touche la carte…" : rt[k] ? `Déplacer ${k.toUpperCase()}` : `Placer ${k.toUpperCase()}`;
    $(`rt-${k}`).classList.toggle("on", rt.pick === k);
  }
  $("rt-b").hidden = loop;
  $("rt-loop-opts").hidden = !loop;
  document.querySelectorAll("#rt-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === rt.mode));
  $("rt-go").disabled = rt.busy || !(rt.a && (loop || rt.b));
  $("rt-again").disabled = $("rt-avoid").disabled = rt.busy;
  $("rt-go").textContent = loop ? "Calculer la boucle" : "Calculer l'itinéraire";
  $("rt-again").hidden = !(rt.trace && traces.includes(rt.trace));
  $("rt-avoid").hidden = !(rt.trace && traces.includes(rt.trace));
}

function rtPick(k) {
  stopPicking();
  rt.pick = rt.pick === k ? null : k;
  $("map").classList.toggle("picking", !!rt.pick);
  hint(rt.pick ? `Touche la carte pour placer ${k === "c" ? "le centre de la carte des chemins" : k.toUpperCase()}` : "");
  rtDraw();
  if (rt.pick) showMap();
}

map.on("click", (e) => {
  if (!rt.pick) return rt.scan && !picking && cpPopup(e);
  rt[rt.pick] = [e.latlng.lng, e.latlng.lat];
  // nouvelle emprise pour un itinéraire : le réseau sera rechargé (la carte des chemins garde le sien s'il la couvre)
  if (rt.pick !== "c") { rt.net = null; rt.avoid.clear(); rt.loop = rt.via = null; }
  rt.pick = null;
  $("map").classList.remove("picking");
  hint("");
  rtDraw();
  if (panel.dataset.snap === "peek") sheetTo("half"); // point placé : retour aux réglages
});
map.on("popupopen", () => rt.pick && map.closePopup());

// Charge le réseau d'une emprise, sauf si celui en mémoire la couvre déjà
async function ensureNet(bbox) {
  const b = rt.netBox;
  if (rt.net && b[0] <= bbox[0] && b[1] <= bbox[1] && b[2] >= bbox[2] && b[3] >= bbox[3]) return rt.net;
  status("Chargement du réseau IGN…", 0);
  const [feats, zones] = await Promise.all([
    fetchNetwork(bbox, (f) => status("Chargement du réseau IGN…", f)),
    fetchStrongZones(bbox).catch((e) => { console.warn("zones", e); return []; }),
  ]);
  status("Construction du graphe…", null);
  await new Promise((r) => setTimeout(r));
  rt.avoid.clear(); // les tronçons écartés appartenaient à l'ancien graphe
  rt.net = buildGraph(feats, zones);
  rt.netBox = bbox;
  rtLearnRates(rt.net); // d'après les verdicts déjà connus
  return rt.net;
}

function boxAround(pts, pad) {
  const lat = pts.reduce((a, p) => a + p[1], 0) / pts.length, dLat = pad / 111320, dLon = dLat / Math.cos(lat * rad);
  return [Math.min(...pts.map((p) => p[0])) - dLon, Math.min(...pts.map((p) => p[1])) - dLat,
    Math.max(...pts.map((p) => p[0])) + dLon, Math.max(...pts.map((p) => p[1])) + dLat];
}

async function rtRun(round = 0) {
  const { a, b } = rt, loop = rt.mode === "loop", pref = +$("rt-pref").value;
  let chained = false; // un contournement prend le relais : les boutons restent bloqués
  rt.busy = true;
  rt.tech = +$("rt-tech").value;
  // la carte des chemins publics s'efface pour laisser lire l'itinéraire (ses verdicts restent acquis)
  if (rt.scan) { rt.scan = null; rtShowScan(); }
  rtDraw();
  try {
    let g, compute;
    if (loop) {
      const target = +$("rt-km").value * 1000;
      // le cercle peut grandir jusqu'à 1,6 fois son rayon de départ lors du calibrage
      g = await ensureNet(boxAround([a], (RT_MAX_SCALE * 2 * target) / (2 * Math.PI * RT_DETOUR) + 2000));
      // tout le cadastre du secteur d'abord : la boucle se choisit sur des chemins déjà vérifiés
      if (pref) await checkArea(g, a, Math.min(RT_PRECHECK_MAX, (RT_PRECHECK * target) / (2 * Math.PI * RT_DETOUR)), "Vérification du cadastre autour de A");
      compute = async (k) => {
        // secteur déjà vérifié : la boucle choisie au premier tour est réparée, pas remplacée
        rt.loop = await planLoop(g, a, target, pref, rt.seed, round || k > (pref ? 1 : RT_EXPLORE) ? rt.loop : null,
          (f) => status(`Recherche d'une boucle · vérification du cadastre (${k})…`, f));
        if (!rt.loop) throw new Error("aucune boucle autorisée trouvée autour de A");
        return rt.loop.path;
      };
    } else {
      const km = dist(a, b) / 1000;
      if (km > RT_MAX_KM) throw new Error(`A et B sont à ${Math.round(km)} km à vol d'oiseau : maximum ${RT_MAX_KM} km pour l'instant.`);
      g = await ensureNet(boxAround([a, b], Math.max(2000, km * 1000 * 0.25)));
      compute = () => {
        const mask = mainComponent(g, rt.avoid);
        const s = nearestNode(g, a, rt.avoid, mask), t = nearestNode(g, b, rt.avoid, mask);
        if (s.i < 0 || t.i < 0) throw new Error("aucune voie autorisée près de A ou de B");
        // « nouvelle trace » : un point de passage tiré au hasard de part et d'autre de la ligne A-B
        const via = rt.via && nearestNode(g, offset(offset(a, rt.via.along * km * 1000, rt.via.bearing), rt.via.side * km * 1000, rt.via.bearing + Math.PI / 2), rt.avoid, mask).i;
        const p = chainPath(g, via >= 0 && via != null ? [s.i, via, t.i] : [s.i, t.i], pref);
        if (!p) throw new Error("aucun itinéraire autorisé ne relie A et B");
        return p;
      };
    }
    // calcul → contrôle du cadastre des tronçons nouveaux → recalcul sans les privés, jusqu'à stabilité
    const strict = $("rt-strict").checked;
    let path, fails = 0;
    for (let k = 1; ; k++) {
      status(`${loop ? "Recherche d'une boucle" : "Recherche d'un itinéraire"} · vérification du cadastre (${k})…`, null);
      await new Promise((r) => setTimeout(r));
      path = await compute(k);
      if (k > RT_CHECK_ROUNDS) break;
      // cadastre indisponible deux fois de suite : on passe à l'analyse, qui signalera ce qui reste à éviter
      const { n, failed } = await checkEdges(path.edges, strict).catch((e) => (console.warn("cadastre", e), { n: 0, failed: true }));
      fails = failed ? fails + 1 : 0;
      if (fails >= 2 || (!n && !failed)) break;
    }
    status(round ? `Contournement des points d'attention (${round}/${RT_AUTO_ROUNDS})…` : "");
    if (rt.trace && traces.includes(rt.trace)) removeTrace(rt.trace);
    const name = `${loop ? `Boucle ${$("rt-km").value} km` : "Itineraire"} ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }).replace(":", "h")}`;
    await analyseFiles([new File([toGpx(name, [path.coords])], `${name}.gpx`)]);
    rt.trace = traces.at(-1);
    rt.trace.route = { edges: path.edges };
    rt.trace.onOsm = rtOsmLearn;
    // les points d'attention IGN et cadastre sont connus tout de suite : on les contourne sans attendre
    if (rt.trace.res.alerts.length && round < RT_AUTO_ROUNDS && (chained = rtAvoid(round + 1))) return;
    status("");
  } catch (e) {
    console.error(e);
    status(`Calcul impossible : ${e.message}`, null, true);
  } finally {
    if (!chained) { rt.busy = false; rtDraw(); }
  }
}

// Carte des chemins publics : vérifie le cadastre de tous les chemins à moins du rayon choisi autour du centre et les
// dessine au fur et à mesure, du centre vers l'extérieur (arrêt possible à tout moment), pour choisir un départ ou
// tracer soi-même sa sortie (export GPX). Les verdicts servent aussi au calcul des itinéraires.
const RT_SCAN_BATCH = 1500; // tronçons vérifiés entre deux mises à jour de la carte
const scanRenderer = L.canvas({ padding: 0.3 }); // des dizaines de milliers de traits : dessin sur canvas

// Vérifie le cadastre de tous les chemins pas encore contrôlés à moins de r du point a : par anneaux de 1 km
// depuis a ; dans un anneau, serpentin par cellules d'environ 500 m pour que chaque lot de requête couvre un
// petit secteur. after(distance atteinte) après chaque lot ; stop() arrête entre deux lots.
async function checkArea(g, a, r, label, after = () => {}, stop = () => false) {
  const list = g.edges.filter((e) => isDirt(e) && !e.ban && !e.checked && dist(e.mid, a) <= r);
  const ring = (e) => Math.floor(dist(e.mid, a) / 1000);
  const cell = (e) => { const y = Math.floor(e.mid[1] / 0.0045), x = Math.floor(e.mid[0] / 0.006); return y * 1e6 + (y % 2 ? -x : x); };
  list.sort((p, q) => ring(p) - ring(q) || cell(p) - cell(q));
  const total = list.reduce((s, e) => s + e.len, 0), km = (m) => Math.round(m / 1000);
  let done = 0;
  for (let i = 0; i < list.length && !stop(); i += RT_SCAN_BATCH) {
    const part = list.slice(i, i + RT_SCAN_BATCH), len = part.reduce((s, e) => s + e.len, 0);
    await checkEdges(part, $("rt-strict").checked, (f) =>
      status(`${label} : ${km(done + f * len)} / ${km(total)} km de chemins…`, (done + f * len) / total));
    done += len;
    after(dist(part.at(-1).mid, a));
  }
}

async function rtScan() {
  const a = rt.c, r = +$("cp-km").value * 1000;
  rt.busy = rt.scanning = true;
  rt.scanStop = false;
  rtDraw();
  try {
    const g = await ensureNet(boxAround([a], r + 2000));
    rt.scan = { a, r, reach: 0 };
    rtShowScan(true);
    await checkArea(g, a, r, "Vérification du cadastre", (reach) => { rt.scan.reach = reach; rtShowScan(); }, () => rt.scanStop);
    rt.scan.reach = rt.scanStop ? rt.scan.reach : r;
    rtShowScan();
    status("");
  } catch (e) {
    console.error(e);
    status(`Vérification impossible : ${e.message}`, null, true);
  } finally {
    rt.busy = rt.scanning = false;
    rtDraw();
  }
}

// Chemins publics vérifiés dans le rayon de la carte
const scanPublic = (expl = false) => rt.net.edges.filter((e) => isDirt(e) && e.checked && !!e.expl === expl
  && (!e.ban || (expl && e.ban === RT_EXPL)) && dist(e.mid, rt.scan.a) <= rt.scan.r);
// chemin d'exploitation (orange), autorisé ou non pour le générateur
const isExpl = (e) => e.expl && (!e.ban || e.ban === RT_EXPL);

function rtShowScan(fit) {
  rt.scanLayer.clearLayers();
  rt.scanGrid = null;
  $("cp-info").hidden = $("cp-gpx").hidden = !rt.scan;
  if (!rt.scan) return;
  const grid = (rt.scanGrid = new Grid(0.003)); // pour retrouver le chemin touché sur la carte
  const { a, r, reach } = rt.scan, km = { pub: 0, priv: 0, todo: 0, road: 0, expl: 0 }, lines = { pub: [], priv: [], todo: [], expl: [] };
  for (const e of rt.net.edges) {
    const d = dist(e.mid, a);
    if (d > reach) continue;
    if (!isDirt(e)) { if (!e.ban) km.road += e.len; continue; }
    const k = isExpl(e) ? "expl" : !e.ban ? (e.checked ? "pub" : "todo") : "priv";
    km[k] += e.len;
    lines[k].push(e.coords.map((c) => [c[1], c[0]]));
    const xs = e.coords.map((c) => c[0]), ys = e.coords.map((c) => c[1]);
    grid.add([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], e);
  }
  // une polyligne multiple par catégorie : léger à dessiner
  for (const [k, color, weight, opacity] of [["todo", "--neutral", 2, 0.5], ["priv", "--s8", 2, 0.55], ["expl", "--s2", 3, 0.9], ["pub", "--s3", 4, 0.95]])
    if (lines[k].length) L.polyline(lines[k], { renderer: scanRenderer, color: css(color), weight, opacity, interactive: false }).addTo(rt.scanLayer);
  L.circle([a[1], a[0]], { radius: r, color: css("--text-muted"), weight: 1, dashArray: "4 4", fill: false, interactive: false }).addTo(rt.scanLayer);
  if (reach < r) L.circle([a[1], a[0]], { radius: reach, color: css("--accent"), weight: 1, fill: false, interactive: false }).addTo(rt.scanLayer);
  // ce qui compte pour une boucle : les chemins publics face aux routes qui les relient
  const f = (m) => `${Math.round(m / 1000)} km`, share = km.pub / Math.max(1, km.pub + km.road);
  $("cp-info").innerHTML = (reach < r ? `Vérifié jusqu'à ${(reach / 1000).toFixed(1)} km sur ${r / 1000}${rt.scanning ? " (en cours)" : " (arrêté)"}. ` : "") +
    `À moins de ${(reach / 1000).toFixed(reach < r ? 1 : 0)} km du centre : <b>${f(km.pub)} de chemins publics</b> (en vert) pour ${f(km.road)} de routes, ` +
    (km.expl > 500 ? `${f(km.expl)} de chemins d'exploitation (en orange) ` : "") +
    `et ${f(km.priv)} de chemins privés ou interdits (en rouge)` + (km.todo > 500 ? `, ${f(km.todo)} non vérifiés (en gris)` : "") + `. ` +
    (share < 0.25 ? "Secteur pauvre : une boucle par ici passera surtout par la route." : share < 0.35 ? "Secteur moyen." : "Secteur favorable.") +
    " Touche un chemin pour savoir pourquoi.";
  if (fit) map.fitBounds(L.latLng(a[1], a[0]).toBounds(2 * r));
}

// Explication du verdict d'un chemin de la carte, au toucher (à moins de 12 pixels)
const RT_BAN_TEXT = {
  [RT_EXPL]: "chemin d'exploitation non autorisé",
  "voie privée": "voie privée (IGN)",
  "Restreint aux ayants droit": "accès réservé aux ayants droit (IGN)",
  "Physiquement impossible": "impraticable (IGN)",
  "zone protégée": "dans une réserve naturelle, un biotope protégé ou un cœur de parc national",
};
function cpPopup(ev) {
  // un clic sur une trace analysée ouvre déjà son propre détail
  if (ev.originalEvent && ev.originalEvent.target.tagName === "path") return;
  const p = [ev.latlng.lng, ev.latlng.lat], tol = (12 * 156543 * Math.cos(p[1] * rad)) / 2 ** map.getZoom();
  let best = null, bd = tol;
  for (const e of rt.scanGrid.at(p[0], p[1]))
    for (let i = 1; i < e.coords.length; i++) {
      const d = segDist(p, e.coords[i - 1], e.coords[i]).d;
      if (d < bd) { bd = d; best = e; }
    }
  if (!best) return;
  const e = best, w = e.why, m = (x) => `${Math.round(x)} m`, owners = w && w.o ? { [w.f.properties.idu]: w.o } : {};
  const head = `<b>${esc(e.f.properties.nature)}</b> ${muted(m(e.len))}<br>`, tag = (t, c) => `<b style="color:${css(c)}">${t}</b>`;
  let body;
  if (isExpl(e))
    body = `${tag("Chemin d'exploitation", "--s2")} : sur ${m(w.m.exploit)}, le chemin a sa propre parcelle privée ` +
      `(propriétaires riverains en indivision, ou bande étroite cadastrée à part). Les propriétaires peuvent en interdire ` +
      `l'accès (Code rural, art. L162-1) : ouvert sauf panneau ou barrière.<br>` +
      muted(e.ban ? "Le générateur l'évite, sauf si tu coches « Autoriser les chemins d'exploitation »." : "Le générateur peut l'utiliser (case cochée).") +
      "<br>" + (w.f ? parcelPopup(w.f, owners) : "");
  else if (e.ban === "parcelle privée")
    body = `${tag("Privé", "--s8")} : ` + (w.m.joint > w.m.prive / 2
      ? `suit sur ${m(w.m.prive)} la limite entre parcelles privées, sans bande non cadastrée à côté : sans doute un chemin d'exploitation privé.<br>`
      : `traverse une parcelle privée sur ${m(w.m.prive)}<br>`) + (w.f ? parcelPopup(w.f, owners) : "");
  else if (e.ban === RT_FERME)
    body = `${tag("Fermé", "--s8")} : traverse sur ${m(w.m.ferme)} un terrain de l'État ou d'un établissement public (camp militaire, ` +
      `forêt domaniale, hôpital, voie ferrée…). Ce n'est pas un chemin rural : il n'est pas ouvert à la circulation publique.<br>` +
      (w.f ? parcelPopup(w.f, owners) : "");
  else if (e.ban)
    body = `${tag("Interdit", "--s8")} : ` + (e.ban.startsWith("OSM ") ? `interdit dans OpenStreetMap (${esc(e.ban.slice(4))})` : esc(RT_BAN_TEXT[e.ban] || e.ban));
  else if (!e.checked) body = `${tag("Non vérifié", "--neutral")} : le cadastre n'a pas répondu pour ce chemin.`;
  else body = `${tag("Public", "--s3")} : ` + ({
    noncad: "hors parcelle cadastrée (voie publique).",
    public: "sur une parcelle publique :<br>" + (w.f ? parcelPopup(w.f, owners) : ""),
    limite: `en limite de parcelle privée (à moins de ${EDGE_TOL} m), le long d'une bande non cadastrée : sans doute un chemin rural mal calé sur le cadastre.`,
  }[w.main] || "pas de parcelle privée traversée.") + `<br>${muted("Vérifie quand même la signalisation sur place.")}`;
  L.popup().setLatLng(ev.latlng).setContent(head + body).openOn(map);
}

// Chemins publics bout à bout : les tronçons qui se suivent sans embranchement forment une seule ligne
function joinEdges(edges) {
  const at = new Map();
  for (const e of edges) for (const v of [e.a, e.b]) (at.get(v) || at.set(v, []).get(v)).push(e);
  const seen = new Set(), out = [];
  for (const e of edges) {
    if (seen.has(e)) continue;
    seen.add(e);
    const line = [...e.coords];
    // vers l'avant depuis e.b, puis vers l'arrière depuis e.a
    for (const back of [false, true]) {
      let n = back ? e.a : e.b;
      for (;;) {
        const next = at.get(n);
        if (next.length !== 2) break;
        const x = next.find((y) => !seen.has(y)); // l'autre tronçon (déjà pris : boucle fermée)
        if (!x) break;
        seen.add(x);
        const c = x.a === n ? x.coords : [...x.coords].reverse(); // c part de n
        if (back) line.unshift(...c.slice(1).reverse()); else line.push(...c.slice(1));
        n = x.a === n ? x.b : x.a;
      }
    }
    out.push(line);
  }
  return out;
}

// OSM arrive après coup, par tuiles d'environ 1 km autour de l'itinéraire : on s'en sert pour écarter tous les
// chemins interdits aux motos du voisinage (pas seulement ceux de l'itinéraire) dans les calculs suivants.
// L'itinéraire affiché n'est pas recalculé tout seul (une trace qui change sans cesse est inutilisable) : ses
// interdictions OSM s'affichent en rouge et « Éviter les points d'attention » le recalcule sans elles.
// Seuls les chemins BD TOPO sont concernés : une route peut longer un trottoir cartographié à part dans OSM.
function rtOsmLearn(feats) {
  const g = rt.net;
  if (!g) return false;
  const cand = g.edges.filter((e) => !e.ban && ["Chemin", "Route empierrée"].includes(e.f.properties.nature));
  matchNearest(cand.map((e) => ({ p: e.mid })), feats).forEach(([f], i) => {
    const ban = f && osmMotoBan(f.properties, cand[i].f.properties.nature);
    if (ban) cand[i].ban = "OSM " + ban;
  });
  return false;
}

// Écarte les tronçons où l'analyse a trouvé un point d'attention (parcelle privée, interdiction OSM…) et recalcule
// Renvoie true si un nouveau calcul a été lancé.
function rtAvoid(round = 0) {
  const t = rt.trace;
  if (!t || !t.route) return false;
  const pts = t.res.alerts.flatMap((al) => al.latlngs.map(([la, lo]) => [lo, la]));
  if (!pts.length) return status("Aucun point d'attention à éviter sur cet itinéraire."), false;
  const grid = new Grid(0.001);
  for (const p of pts) grid.add([p[0], p[1], p[0], p[1]], p);
  let n = 0;
  for (const e of t.route.edges) {
    const hit = e.coords.some((c) => [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) =>
      grid.at(c[0] + dx * 0.001, c[1] + dy * 0.001).some((p) => dist(p, c) < 20))));
    if (hit && !rt.avoid.has(e)) { rt.avoid.add(e); n++; }
  }
  if (!n) return status(round ? "" : "Les points d'attention ne correspondent à aucun tronçon évitable."), false;
  rtRun(round);
  return true;
}

$("rt-a").addEventListener("click", () => rtPick("a"));
$("rt-b").addEventListener("click", () => rtPick("b"));
// la sélection d'une section annule le placement de A ou B
$("sec-pick").addEventListener("click", () => { if (rt.pick) { rt.pick = null; rtDraw(); } });
$("rt-go").addEventListener("click", () => { rt.avoid.clear(); rt.loop = rt.via = null; rtRun(); });
// autre boucle : on tourne le cercle autour du départ
// nouvelle trace, mêmes réglages : d'autres orientations de boucle, ou un détour au hasard entre A et B
$("rt-again").addEventListener("click", () => {
  rt.avoid.clear(); rt.loop = null;
  rt.seed += Math.PI / RT_CANDIDATES + Math.random() * 2 * Math.PI;
  if (rt.a && rt.b) {
    const bearing = Math.atan2((rt.b[0] - rt.a[0]) * Math.cos(rt.a[1] * rad), rt.b[1] - rt.a[1]);
    rt.via = { bearing, along: 0.3 + Math.random() * 0.4, side: (Math.random() < 0.5 ? -1 : 1) * (0.15 + Math.random() * 0.25) };
  }
  rtRun();
});
document.querySelectorAll("#rt-mode button").forEach((b) => b.addEventListener("click", () => { rt.mode = b.dataset.mode; rt.loop = rt.via = null; rtDraw(); }));
$("rt-strict").addEventListener("change", () => {
  rt.verdict.clear();
  rt.scan = null; rtShowScan(); rtDraw(); // la carte des chemins publics dépend de ce réglage
  if (rt.net) rt.net.rates = null;
  for (const e of rt.net ? rt.net.edges : []) { e.checked = e.expl = false; if (e.ban === "parcelle privée" || e.ban === RT_EXPL) e.ban = null; }
});
$("rt-expl").addEventListener("change", (ev) => {
  for (const e of rt.net ? rt.net.edges : []) if (e.expl) {
    if (ev.target.checked && e.ban === RT_EXPL) e.ban = null;
    else if (!ev.target.checked && !e.ban) e.ban = RT_EXPL;
  }
  if (rt.net) rt.net.rates = null;
  rt.loop = null;
  rtShowScan(); rtDraw();
});
$("rt-km").addEventListener("input", (e) => { $("rt-km-v").textContent = `${e.target.value} km`; rt.loop = null; });
$("rt-avoid").addEventListener("click", () => rtAvoid());
$("cp-pick").addEventListener("click", () => rtPick("c"));
$("cp-go").addEventListener("click", () => (rt.scanning ? (rt.scanStop = true) : rtScan()));
$("cp-clear").addEventListener("click", () => { rt.scan = null; rtShowScan(); rtDraw(); });
$("cp-km").addEventListener("input", (e) => { $("cp-v").textContent = `${e.target.value} km`; rtDraw(); });
$("cp-gpx").addEventListener("click", () => {
  // un point tous les 25 m au plus, sans altitude : fichier 2 à 3 fois plus léger pour GPX Studio
  const thin = (l) => {
    const out = [l[0]];
    for (let i = 1; i < l.length; i++) if (i === l.length - 1 || dist(l[i], out.at(-1)) >= 25) out.push(l[i]);
    return out.map((c) => [c[0], c[1]]);
  };
  saveGpx(`Chemins publics ${rt.scan.r / 1000} km`, joinEdges(scanPublic()).map(thin),
    { "Chemins d'exploitation (ouverts sauf panneau)": joinEdges(scanPublic(true)).map(thin) });
});
$("rt-tech").addEventListener("input", (e) => { $("rt-tech-v").textContent = e.target.value >= 0.7 ? "virages et pentes" : e.target.value <= 0.2 ? "roulant" : "un peu des deux"; });
$("rt-pref").addEventListener("input", (e) => { $("rt-pref-v").textContent = e.target.value >= 0.7 ? "le plus de chemins" : e.target.value <= 0.3 ? "le plus court" : "équilibré"; });
$("gpx-out").addEventListener("click", () => {
  if (!active) return;
  const v = view(active);
  saveGpx(v.name, active.sec ? [v.samples.map((s) => [...s.p, s.z])] : v.lines);
});
$("rb-pdf").addEventListener("click", () => {
  if (!active || !active.res.roads) return;
  const v = view(active), cases = roadbook(v.samples, active.res.roads);
  const w = window.open(URL.createObjectURL(new Blob([roadbookPage(`${v.name} roadbook`, v.samples, cases, v.elev)], { type: "text/html" })), "_blank");
  if (!w) alert("Le navigateur a bloqué l'ouverture du roadbook : autorise les fenêtres pop-up pour ce site.");
});
$("rb-out").addEventListener("click", () => {
  if (!active || !active.res.roads) return;
  const v = view(active), cases = roadbook(v.samples, active.res.roads);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([roadbookGpx(`${v.name} roadbook`, v.samples, cases)], { type: "application/gpx+xml" }));
  a.download = `${v.name} roadbook.gpx`; a.click();
});
rtDraw();
