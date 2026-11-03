"use strict";
// Itinéraire « légal » : plus court chemin sur le réseau BD TOPO, en écartant les voies a priori interdites
// aux motos et en préférant les chemins aux routes. S'appuie sur les fonctions de app.js (wfs, pool, dist…).

const RT_TILE = 0.05;        // degrés : taille des tuiles téléchargées
const RT_MAX_KM = 80;        // distance à vol d'oiseau maximale entre A et B
const RT_AUTO_ROUNDS = 3;    // contournements automatiques des points d'attention IGN / cadastre
const RT_OSM_ROUNDS = 3;     // recalculs automatiques quand OpenStreetMap révèle de nouvelles interdictions
const RT_DETOUR = 1.3;       // rapport longueur réelle / longueur du cercle (les chemins serpentent)
const RT_CANDIDATES = 10;    // boucles essayées (orientations et nombres de points différents), on garde la meilleure
const RT_MAX_SCALE = 1.6;    // agrandissement maximal du cercle lors du calibrage (l'emprise chargée en tient compte)
const RT_REUSE = 4;          // surcoût d'un tronçon déjà emprunté par la boucle (évite les allers-retours)
const RT_PRIV_MIN = 20;      // m en parcelle privée à partir desquels un tronçon est écarté
const RT_CHECK_ROUNDS = 15;  // vérifications du cadastre (puis recalcul) avant l'analyse complète
const RT_PROPS = "geometrie,nature,importance,prive,acces_vehicule_leger,sens_de_circulation";
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
  if (inZone(mid).length) return "zone protégée";
  return null;
}

// pref : 0 = plus court, 1 = le plus de chemins possible (une petite route y coûte jusqu'à 5 fois un chemin)
const RT_PREF_GAIN = 4;
function rtFactor(p, pref) {
  const base = p.nature === "Chemin" ? 1 : p.nature === "Route empierrée" ? 1.15 : RT_ROAD_FACTOR[p.importance] || 3;
  return 1 + RT_PREF_GAIN * pref * (base - 1);
}

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
    const e = { f, coords: part, len, mid, ban: rtBan(f.properties, inZone, mid) };
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

// A* : renvoie la liste des coordonnées [lon, lat] et les tronçons empruntés, ou null
function shortestPath(g, from, to, pref, avoid, used = new Set()) {
  const n = g.xy.length, cost = new Float64Array(n).fill(Infinity), prev = new Array(n);
  const goal = g.xy[to], h = (i) => dist(g.xy[i], goal); // admissible : aucun tronçon ne coûte moins de 1 par mètre
  const heap = new Heap();
  cost[from] = 0; heap.push(h(from), from);
  while (heap.size) {
    const u = heap.pop();
    if (u === to) break;
    for (const s of g.adj[u]) {
      if (s.e.ban || avoid.has(s.e)) continue;
      const c = cost[u] + s.e.len * rtFactor(s.e.f.properties, pref) * (used.has(s.e) ? RT_REUSE : 1);
      if (c < cost[s.to]) { cost[s.to] = c; prev[s.to] = s; heap.push(c + h(s.to), s.to); }
    }
  }
  if (cost[to] === Infinity) return null;
  const steps = [];
  for (let v = to; v !== from; v = steps.at(-1).from) { const s = prev[v]; steps.push({ ...s, from: s.fwd ? s.e.a : s.e.b }); }
  steps.reverse();
  const coords = [g.xy[from]];
  const segs = steps.map((s) => (s.fwd ? s.e.coords : [...s.e.coords].reverse()));
  for (const c of segs) coords.push(...c.slice(1).map((p) => [p[0], p[1]]));
  return { coords, edges: steps.map((s) => s.e), segs };
}

function toGpx(name, lines) {
  const pt = (p) => `<trkpt lat="${p[1].toFixed(7)}" lon="${p[0].toFixed(7)}">${p[2] != null ? `<ele>${p[2].toFixed(1)}</ele>` : ""}</trkpt>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Analyseur de traces GPX" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `<trk><name>${esc(name)}</name>${lines.map((l) => `<trkseg>${l.map(pt).join("")}</trkseg>`).join("")}</trk>\n</gpx>\n`;
}

function saveGpx(name, lines) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([toGpx(name, lines)], { type: "application/gpx+xml" }));
  a.download = `${name}.gpx`; a.click();
}

// Enchaîne les plus courts chemins entre des nœuds successifs ; un tronçon déjà parcouru coûte plus cher
function chainPath(g, nodes, pref) {
  const used = new Set(), coords = [], edges = [], segs = [];
  for (let i = 1; i < nodes.length; i++) {
    const p = shortestPath(g, nodes[i - 1], nodes[i], pref, rt.avoid, used);
    if (!p) return null;
    coords.push(...(coords.length ? p.coords.slice(1) : p.coords));
    for (const e of p.edges) { edges.push(e); used.add(e); }
    segs.push(...p.segs);
  }
  return { coords, edges, segs, len: edges.reduce((a, e) => a + e.len, 0) };
}

// Vérifie le cadastre des tronçons d'un itinéraire pas encore contrôlés et écarte ceux qui traversent
// une parcelle privée. strict : compte aussi les passages à moins de EDGE_TOL m d'une limite de parcelle
// (souvent un chemin rural mal calé sur le cadastre, mais parfois un chemin d'exploitation privé).
// Renvoie le nombre de tronçons écartés.
async function checkPrivate(path, strict) {
  const idx = path.edges.map((e, i) => i).filter((i) => !path.edges[i].checked && !path.edges[i].ban);
  if (!idx.length) return 0;
  // tronçons consécutifs à contrôler, réunis en lignes continues pour limiter le nombre de requêtes
  const lines = [];
  idx.forEach((i, k) => {
    if (k && idx[k - 1] === i - 1) lines.at(-1).push(...path.segs[i].slice(1));
    else lines.push([...path.segs[i]]);
  });
  const found = new Map();
  for (const feats of await pool(chunks(lines).map((c) => () =>
    wfs("CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle", { CQL_FILTER: `DWITHIN(geom,${wkt(c)},8,meters)` })), 3))
    for (const f of feats) found.set(f.id, f);
  const parcels = [...found.values()];
  const owners = await fetchOwners([...new Set(parcels.map((f) => f.properties.idu))]);
  const inParcel = polyIndex(parcels);
  let n = 0;
  for (const i of idx) {
    const e = path.edges[i];
    e.checked = true;
    let priv = 0;
    for (let j = 1; j < e.coords.length; j++) {
      const a = e.coords[j - 1], b = e.coords[j], d = dist(a, b), k = Math.max(1, Math.ceil(d / STEP));
      for (let m = 0; m < k; m++) {
        const t = (m + 0.5) / k, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], f = inParcel(p);
        if (!f) continue;
        const c = parcelCat(f, owners);
        if ((c === "particulier" || c === "pmprivee") && (strict || boundaryDist(p, f) >= EDGE_TOL)) priv += d / k;
      }
    }
    if (priv >= RT_PRIV_MIN || priv > e.len / 2) { e.ban = "parcelle privée"; n++; }
  }
  return n;
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

const dirtShare = (p) => p.edges.reduce((a, e) => a + (["Chemin", "Route empierrée"].includes(e.f.properties.nature) ? e.len : 0), 0) / p.len;

// Une boucle : cercle passant par A, orienté selon theta, avec n points recalés sur le réseau ;
// le rayon est corrigé jusqu'à ce que la longueur réelle soit à 7 % de la cible.
function loopCandidate(g, start, a, mask, target, pref, theta, n) {
  let scale = 1, best = null;
  for (let k = 0; k < 7; k++) {
    const r = (scale * target) / (2 * Math.PI * RT_DETOUR), c = offset(a, r, theta);
    const nodes = [start];
    for (let i = 1; i < n; i++) nodes.push(nearestNode(g, offset(c, r, theta + Math.PI + (2 * Math.PI * i) / n), rt.avoid, mask).i);
    nodes.push(start);
    const path = chainPath(g, nodes, pref);
    if (!path) break;
    if (!best || Math.abs(path.len - target) < Math.abs(best.path.len - target)) best = { path, theta, n };
    if (Math.abs(path.len / target - 1) < 0.07) break;
    scale = Math.min(RT_MAX_SCALE, Math.max(0.3, scale * target / path.len));
  }
  return best;
}

// Choisit la boucle qui a le plus de chemins à la bonne distance parmi RT_CANDIDATES orientations.
// Le choix est refait à chaque contrôle du cadastre : une boucle qui perd ses chemins privés peut être détrônée.
function planLoop(g, a, target, pref, seed) {
  const mask = mainComponent(g, rt.avoid);
  const start = nearestNode(g, a, rt.avoid, mask).i;
  if (start < 0) return null;
  const score = (l) => (pref ? dirtShare(l.path) : 0) - 2 * Math.abs(l.path.len / target - 1);
  let best = null;
  for (let i = 0; i < RT_CANDIDATES; i++) {
    const l = loopCandidate(g, start, a, mask, target, pref, seed + (2 * Math.PI * i) / RT_CANDIDATES, 4 + (i % 2));
    if (l && (!best || score(l) > score(best))) best = l;
  }
  return best;
}

// ---------- Interface ----------
const rt = { mode: "ab", a: null, b: null, pick: null, net: null, netBox: null, avoid: new Set(), osmRounds: 0,
  loop: null, via: null, seed: Math.random() * 2 * Math.PI, trace: null, markers: L.layerGroup().addTo(map) };

function rtDraw() {
  rt.markers.clearLayers();
  const loop = rt.mode === "loop";
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
  hint(rt.pick ? `Touche la carte pour placer ${k.toUpperCase()}` : "");
  rtDraw();
  if (rt.pick && window.matchMedia("(max-width: 800px)").matches) $("map").scrollIntoView({ behavior: "smooth" });
}

map.on("click", (e) => {
  if (!rt.pick) return;
  rt[rt.pick] = [e.latlng.lng, e.latlng.lat];
  rt.net = null; rt.avoid.clear(); rt.loop = rt.via = null; // nouvelle emprise : le réseau sera rechargé
  rt.pick = null;
  $("map").classList.remove("picking");
  hint("");
  rtDraw();
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
  rtDraw();
  try {
    let g, compute;
    if (loop) {
      const target = +$("rt-km").value * 1000;
      // le cercle peut grandir jusqu'à 1,6 fois son rayon de départ lors du calibrage
      g = await ensureNet(boxAround([a], (RT_MAX_SCALE * 2 * target) / (2 * Math.PI * RT_DETOUR) + 2000));
      compute = () => {
        rt.loop = planLoop(g, a, target, pref, rt.seed);
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
    let path;
    for (let k = 1; ; k++) {
      status(`${loop ? "Recherche d'une boucle" : "Recherche d'un itinéraire"} · vérification du cadastre (${k})…`, null);
      await new Promise((r) => setTimeout(r));
      path = compute();
      if (k > RT_CHECK_ROUNDS || !(await checkPrivate(path, strict))) break;
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

// OSM arrive après coup, par tuiles d'environ 1 km autour de l'itinéraire : on s'en sert pour écarter tous les
// chemins interdits aux motos du voisinage (pas seulement ceux de l'itinéraire), puis on recalcule si besoin.
// Seuls les chemins BD TOPO sont concernés : une route peut longer un trottoir cartographié à part dans OSM.
function rtOsmLearn(feats) {
  const g = rt.net;
  if (!g || rt.osmRounds >= RT_OSM_ROUNDS) return false;
  const cand = g.edges.filter((e) => !e.ban && ["Chemin", "Route empierrée"].includes(e.f.properties.nature));
  matchNearest(cand.map((e) => ({ p: e.mid })), feats).forEach(([f], i) => {
    const ban = f && osmMotoBan(f.properties);
    if (ban) cand[i].ban = "OSM " + ban;
  });
  if (!rt.trace.route.edges.some((e) => e.ban)) return false;
  rt.osmRounds++;
  status(`OpenStreetMap signale des chemins interdits : nouvel itinéraire (${rt.osmRounds}/${RT_OSM_ROUNDS})…`);
  rtRun(1);
  return true;
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
$("rt-go").addEventListener("click", () => { rt.avoid.clear(); rt.osmRounds = 0; rt.loop = rt.via = null; rtRun(); });
// autre boucle : on tourne le cercle autour du départ
// nouvelle trace, mêmes réglages : d'autres orientations de boucle, ou un détour au hasard entre A et B
$("rt-again").addEventListener("click", () => {
  rt.avoid.clear(); rt.osmRounds = 0; rt.loop = null;
  rt.seed += Math.PI / RT_CANDIDATES + Math.random() * 2 * Math.PI;
  if (rt.a && rt.b) {
    const bearing = Math.atan2((rt.b[0] - rt.a[0]) * Math.cos(rt.a[1] * rad), rt.b[1] - rt.a[1]);
    rt.via = { bearing, along: 0.3 + Math.random() * 0.4, side: (Math.random() < 0.5 ? -1 : 1) * (0.15 + Math.random() * 0.25) };
  }
  rtRun();
});
document.querySelectorAll("#rt-mode button").forEach((b) => b.addEventListener("click", () => { rt.mode = b.dataset.mode; rt.loop = rt.via = null; rtDraw(); }));
$("rt-strict").addEventListener("change", () => {
  for (const e of rt.net ? rt.net.edges : []) { e.checked = false; if (e.ban === "parcelle privée") e.ban = null; }
});
$("rt-km").addEventListener("input", (e) => { $("rt-km-v").textContent = `${e.target.value} km`; rt.loop = null; });
$("rt-avoid").addEventListener("click", () => rtAvoid());
$("rt-pref").addEventListener("input", (e) => { $("rt-pref-v").textContent = e.target.value >= 0.7 ? "le plus de chemins" : e.target.value <= 0.3 ? "le plus court" : "équilibré"; });
$("gpx-out").addEventListener("click", () => {
  if (!active) return;
  const v = view(active);
  saveGpx(v.name, active.sec ? [v.samples.map((s) => [...s.p, s.z])] : v.lines);
});
rtDraw();
