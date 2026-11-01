/* Straßenjagd – Kernlogik (ohne DOM). Läuft im Browser (window.StreetCore) und in Node (module.exports). */
(function (root) {
  'use strict';

  const R_EARTH = 6371008.8;
  const LAT0 = 49.7913, LON0 = 9.9534; // Würzburg Mitte
  const KX = Math.cos(LAT0 * Math.PI / 180) * Math.PI / 180 * R_EARTH;
  const KY = Math.PI / 180 * R_EARTH;
  const fwd = (lat, lon) => [(lon - LON0) * KX, (lat - LAT0) * KY];
  const inv = (x, y) => [y / KY + LAT0, x / KX + LON0];

  const STREET_TYPES = ['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
    'unclassified', 'residential', 'living_street', 'pedestrian', 'road', 'service'];
  const PATH_TYPES = ['footway', 'path', 'steps', 'cycleway', 'track', 'bridleway'];

  const PIECE_LEN = 20;     // Ziel-Länge eines Abschnitts in m
  const CELL = 40;          // Raster für räumlichen Index in m
  const DONE_SHARE = 0.9;   // ab 90 % gilt eine Straße als erledigt

  function overpassQuery(cityName) {
    const types = STREET_TYPES.concat(PATH_TYPES).join('|');
    return '[out:json][timeout:120];' +
      'rel["boundary"="administrative"]["admin_level"="6"]["name"="' + cityName + '"]->.c;' +
      '.c out geom;' +
      '.c map_to_area->.city;' +
      'way(area.city)["highway"~"^(' + types + ')$"]["name"];' +
      'out geom;' +
      'rel(area.city)["boundary"="administrative"]["admin_level"~"^(9|10)$"];' +
      'out geom;';
  }

  // ---------- Polygone (Even-Odd über alle Randkanten, mit Band-Index) ----------
  class Poly {
    constructor(lines) { // lines: Array von [[lat,lon],...]
      const ex = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          const [x1, y1] = fwd(line[i - 1][0], line[i - 1][1]);
          const [x2, y2] = fwd(line[i][0], line[i][1]);
          ex.push(x1, y1, x2, y2);
          minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2);
          minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
        }
      }
      this.e = ex; this.minX = minX; this.minY = minY; this.maxX = maxX; this.maxY = maxY;
      this.B = 100;
      this.bands = new Map();
      for (let k = 0; k < ex.length; k += 4) {
        const a = Math.floor((Math.min(ex[k + 1], ex[k + 3]) - minY) / this.B);
        const b = Math.floor((Math.max(ex[k + 1], ex[k + 3]) - minY) / this.B);
        for (let j = a; j <= b; j++) {
          let arr = this.bands.get(j); if (!arr) this.bands.set(j, arr = []);
          arr.push(k);
        }
      }
      this.lines = lines;
    }
    contains(x, y) {
      if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false;
      const arr = this.bands.get(Math.floor((y - this.minY) / this.B));
      if (!arr) return false;
      const e = this.e; let inside = false;
      for (const k of arr) {
        const x1 = e[k], y1 = e[k + 1], x2 = e[k + 2], y2 = e[k + 3];
        if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
      }
      return inside;
    }
    sampleCenter() {
      let sx = 0, sy = 0, n = 0;
      for (const l of this.lines) for (const p of l) { const [x, y] = fwd(p[0], p[1]); sx += x; sy += y; n++; }
      return n ? [sx / n, sy / n] : [0, 0];
    }
  }

  function relLines(rel) {
    const out = [];
    for (const m of rel.members || []) {
      if (m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === 'inner' || m.role === '')) {
        out.push(m.geometry.filter(Boolean).map(g => [g.lat, g.lon]));
      }
    }
    return out;
  }

  function cleanDistrictName(n) {
    return (n || '').replace(/^Würzburg[\s\-–]+/i, '').trim() || n || 'Ohne Namen';
  }

  // ---------- Overpass-Antwort → kompakter Datensatz (wird gespeichert) ----------
  function compactFromOverpass(json, cityName) {
    const els = json.elements || [];
    const rels = els.filter(e => e.type === 'relation');
    const cityRel = rels.find(r => r.tags && r.tags.admin_level === '6' && r.tags.name === cityName);
    if (!cityRel) throw new Error('Stadtgrenze von ' + cityName + ' nicht in den Daten gefunden.');
    const cityLines = relLines(cityRel);
    const cityPoly = new Poly(cityLines);

    const levels = { '9': [], '10': [] };
    for (const r of rels) {
      if (r === cityRel || !r.tags) continue;
      const lvl = r.tags.admin_level;
      if (!levels[lvl]) continue;
      const lines = relLines(r);
      if (!lines.length) continue;
      const p = new Poly(lines);
      const [cx, cy] = p.sampleCenter();
      if (!cityPoly.contains(cx, cy)) continue; // Nachbargemeinde
      levels[lvl].push({ name: cleanDistrictName(r.tags.name), lines: lines.map(l => l.map(q => [round6(q[0]), round6(q[1])])) });
    }
    for (const k of Object.keys(levels)) levels[k].sort((a, b) => a.name.localeCompare(b.name, 'de'));

    const rawWays = [];
    for (const w of els) {
      if (w.type !== 'way' || !w.tags || !w.geometry) continue;
      const t = w.tags;
      if (t.area === 'yes') continue;
      const footOk = ['yes', 'designated', 'permissive'].includes(t.foot);
      if (t.foot === 'no') continue;
      if ((t.access === 'private' || t.access === 'no') && !footOk) continue;
      const cat = PATH_TYPES.includes(t.highway) ? 'w' : 's';
      const geom = w.geometry.filter(Boolean).map(g => [round6(g.lat), round6(g.lon)]);
      if (geom.length < 2) continue;
      rawWays.push({ id: w.id, name: t.name.trim(), cat, nodes: w.nodes || [], g: geom });
    }

    // Straßen bilden: gleicher Name + verbunden (gemeinsamer Knoten oder Enden < 40 m)
    const parent = rawWays.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
    const byName = new Map();
    rawWays.forEach((w, i) => { const k = w.name.toLowerCase(); let a = byName.get(k); if (!a) byName.set(k, a = []); a.push(i); });
    for (const idx of byName.values()) {
      if (idx.length < 2) continue;
      const nodeOwner = new Map();
      for (const i of idx) for (const n of rawWays[i].nodes) {
        const o = nodeOwner.get(n); if (o === undefined) nodeOwner.set(n, i); else unite(o, i);
      }
      const ends = idx.map(i => { const g = rawWays[i].g; return [fwd(g[0][0], g[0][1]), fwd(g[g.length - 1][0], g[g.length - 1][1])]; });
      for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
        if (find(idx[a]) === find(idx[b])) continue;
        let close = false;
        for (const p of ends[a]) for (const q of ends[b]) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 40) close = true;
        if (close) unite(idx[a], idx[b]);
      }
    }
    const streetIdx = new Map(); const streets = [];
    const ways = rawWays.map((w, i) => {
      const r = find(i);
      let s = streetIdx.get(r);
      if (s === undefined) { s = streets.length; streetIdx.set(r, s); streets.push({ name: w.name, cat: w.cat }); }
      else if (w.cat === 's') streets[s].cat = 's'; // eine Straße mit Fahrbahn-Teil zählt als Straße
      return { id: w.id, s, c: w.cat, g: w.g };
    });

    return {
      version: 1, city: cityName, fetchedAt: new Date().toISOString(),
      cityLines: cityLines.map(l => l.map(q => [round6(q[0]), round6(q[1])])),
      levels, streets, ways
    };
  }

  function round6(v) { return Math.round(v * 1e6) / 1e6; }

  // ---------- Datensatz → Arbeitsstrukturen (Abschnitte, Index, Bezirke) ----------
  function buildModel(data) {
    const cityPoly = new Poly(data.cityLines);
    const levelPolys = {};
    for (const lvl of Object.keys(data.levels)) levelPolys[lvl] = data.levels[lvl].map(d => new Poly(d.lines));

    const pieces = []; // {w, s, c, len, xy:Float64Array, cum:Float64Array, d9, d10, wi, k}
    // Kreuzungspunkte: Knoten, die in mehreren Wegen vorkommen. Abschnitte enden immer an Kreuzungen,
    // damit beim Abbiegen kein halb gelaufener Abschnitt über die Kreuzung hinausragt.
    const vcount = new Map();
    for (const w of data.ways) for (const q of w.g) { const key = q[0] + ',' + q[1]; vcount.set(key, (vcount.get(key) || 0) + 1); }
    data.ways.forEach((w, wi) => {
      const xy = w.g.map(p => fwd(p[0], p[1]));
      const cum = [0];
      for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
      if (cum[cum.length - 1] < 1) return;
      const cuts = [0];
      for (let i = 1; i < xy.length - 1; i++) if (vcount.get(w.g[i][0] + ',' + w.g[i][1]) > 1 && cum[i] - cum[cuts[cuts.length - 1]] > 0.5) cuts.push(i);
      if (cum[cum.length - 1] - cum[cuts[cuts.length - 1]] > 0.5 || cuts.length === 1) cuts.push(xy.length - 1); else cuts[cuts.length - 1] = xy.length - 1;
      const ranges = [];
      for (let r = 0; r + 1 < cuts.length; r++) {
        const A = cum[cuts[r]], B = cum[cuts[r + 1]];
        const n = Math.max(1, Math.round((B - A) / PIECE_LEN)), step = (B - A) / n;
        for (let k = 0; k < n; k++) ranges.push([A + k * step, A + (k + 1) * step]);
      }
      let vi = 0;
      for (let k = 0; k < ranges.length; k++) {
        const a = ranges[k][0], b = ranges[k][1];
        const at = d => {
          while (vi < cum.length - 2 && cum[vi + 1] < d) vi++;
          const seg = cum[vi + 1] - cum[vi];
          const t = seg > 0 ? (d - cum[vi]) / seg : 0;
          return [xy[vi][0] + (xy[vi + 1][0] - xy[vi][0]) * t, xy[vi][1] + (xy[vi + 1][1] - xy[vi][1]) * t];
        };
        const fixed = [at(a)];
        for (let j = vi + 1; j < cum.length - 1 && cum[j] < b; j++) if (cum[j] > a) fixed.push(xy[j]);
        fixed.push(at(b));
        const flat = new Float64Array(fixed.length * 2), c = new Float64Array(fixed.length);
        for (let j = 0; j < fixed.length; j++) {
          flat[2 * j] = fixed[j][0]; flat[2 * j + 1] = fixed[j][1];
          if (j) c[j] = c[j - 1] + Math.hypot(fixed[j][0] - fixed[j - 1][0], fixed[j][1] - fixed[j - 1][1]);
        }
        const len = c[c.length - 1];
        const mid = pointAt(flat, c, len / 2);
        if (!cityPoly.contains(mid[0], mid[1])) continue;
        const ex = flat[flat.length - 2] - flat[0], ey = flat[flat.length - 1] - flat[1], el = Math.hypot(ex, ey) || 1;
        const p = { w: w.id, wi, k, s: w.s, c: w.c, len, xy: flat, cum: c, mx: mid[0], my: mid[1], ux: ex / el, uy: ey / el, d: {} };
        for (const lvl of Object.keys(levelPolys)) {
          p.d[lvl] = -1;
          const polys = levelPolys[lvl];
          for (let di = 0; di < polys.length; di++) if (polys[di].contains(mid[0], mid[1])) { p.d[lvl] = di; break; }
        }
        pieces.push(p);
      }
    });

    // Raster-Index (Abschnitts-Bounding-Box + maximale Toleranz)
    const grid = new Map();
    const PAD = 35;
    pieces.forEach((p, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let j = 0; j < p.xy.length; j += 2) {
        x0 = Math.min(x0, p.xy[j]); x1 = Math.max(x1, p.xy[j]);
        y0 = Math.min(y0, p.xy[j + 1]); y1 = Math.max(y1, p.xy[j + 1]);
      }
      for (let gx = Math.floor((x0 - PAD) / CELL); gx <= Math.floor((x1 + PAD) / CELL); gx++)
        for (let gy = Math.floor((y0 - PAD) / CELL); gy <= Math.floor((y1 + PAD) / CELL); gy++) {
          const key = gx * 100000 + gy;
          let arr = grid.get(key); if (!arr) grid.set(key, arr = []);
          arr.push(i);
        }
    });

    // Nachbarschaft: Abschnitte, die einen Punkt teilen (gleiche Straße weiter oder Kreuzung)
    const vmap = new Map();
    pieces.forEach((p, i) => {
      for (let j = 0; j < p.xy.length; j += 2) {
        const key = Math.round(p.xy[j] * 2) + ',' + Math.round(p.xy[j + 1] * 2);
        let a = vmap.get(key); if (!a) vmap.set(key, a = []);
        if (a[a.length - 1] !== i) a.push(i);
      }
    });
    const adj = pieces.map(() => []);
    for (const a of vmap.values()) if (a.length > 1) for (const i of a) for (const j of a) if (i !== j && !adj[i].includes(j)) adj[i].push(j);

    // Bezirksebene wählen: die mit Anzahl am nächsten an 13 (Würzburgs Stadtbezirke)
    const lvlKeys = Object.keys(data.levels).filter(k => data.levels[k].length > 1);
    lvlKeys.sort((a, b) => Math.abs(data.levels[a].length - 13) - Math.abs(data.levels[b].length - 13));

    return { data, pieces, grid, adj, cityPoly, defaultLevel: lvlKeys[0] || null, levelsAvailable: lvlKeys };
  }

  function pointAt(flat, cum, d) {
    for (let j = 1; j < cum.length; j++) {
      if (cum[j] >= d || j === cum.length - 1) {
        const seg = cum[j] - cum[j - 1];
        const t = seg > 0 ? (d - cum[j - 1]) / seg : 0;
        return [flat[2 * j - 2] + (flat[2 * j] - flat[2 * j - 2]) * t, flat[2 * j - 1] + (flat[2 * j + 1] - flat[2 * j - 1]) * t];
      }
    }
    return [flat[0], flat[1]];
  }

  // Abstand Punkt → Abschnitt: [Abstand, Position entlang, Richtung x, Richtung y] des nächsten Teilstücks
  function project(p, x, y) {
    const f = p.xy; let best = Infinity, bestS = 0, ux = 1, uy = 0;
    for (let j = 0; j + 3 < f.length; j += 2) {
      const ax = f[j], ay = f[j + 1], bx = f[j + 2], by = f[j + 3];
      const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t, qy = ay + dy * t;
      const d = Math.hypot(x - qx, y - qy);
      if (d < best) { const l = Math.sqrt(l2); best = d; bestS = p.cum[j / 2] + l * t; if (l > 0) { ux = dx / l; uy = dy / l; } }
    }
    return [best, bestS, ux, uy];
  }

  // ---------- Abgleich einer Spur ----------
  // 1. Die GPS-Spur wird geglättet und alle 5 m abgetastet.
  // 2. Ein Hidden-Markov-Modell sucht die plausibelste Abfolge von Straßenabschnitten:
  //    nah an der Spur, passend zur Laufrichtung und zusammenhängend über Kreuzungen.
  //    Ein Zustand „abseits“ fängt Plätze, Parks und Hinterhöfe ab.
  // 3. Gutgeschrieben wird nur, was auf diesem Weg liegt (plus die Gegenfahrbahn derselben Straße).
  const STEP = 5;
  const OFF = -1;

  function settings(opts) {
    const tol = (opts && opts.tolerance) || 20;
    return {
      tol,
      sigma: tol / 2.8,                      // 20 m → σ ≈ 7 m
      radius: Math.min(35, tol * 1.5),       // Suchradius für Kandidaten
      maxAcc: (opts && opts.maxAccuracy) || 35,
      angle0: 30,                            // Grad, Maß für die Richtungsstrafe
      offEmit: -4.5, offTrans: -4,
      tSame: 0, tAdjSame: -0.2, tAdjOther: -1.2, tTwoHop: -2.5, tJump: -12, tBreak: -1
    };
  }

  class Resampler {
    constructor(cfg) { this.cfg = cfg; this.prev = null; this.sm = null; this.last = null; this.anchor = null; this.distance = 0; }
    // → null (Punkt verworfen) oder Liste neuer Abtastpunkte {x, y, t, brk}
    add(lat, lon, t, acc) {
      if (acc != null && acc > this.cfg.maxAcc) return null;
      const [x, y] = fwd(lat, lon);
      let gap = !this.prev;
      if (this.prev) {
        const d = Math.hypot(x - this.prev.x, y - this.prev.y);
        const dt = (t != null && this.prev.t != null) ? (t - this.prev.t) / 1000 : null;
        if (dt != null && dt > 0 && d / dt > 12 && d > 50) return null; // GPS-Sprung
        if (d > 150 || (dt != null && dt > 180)) gap = true;
      }
      this.prev = { x, y, t };
      if (gap || !this.sm) this.sm = { x, y };
      else { this.sm = { x: this.sm.x + 0.35 * (x - this.sm.x), y: this.sm.y + 0.35 * (y - this.sm.y) }; }
      const sm = this.sm;
      if (gap || !this.anchor) this.anchor = { x: sm.x, y: sm.y };
      else { const da = Math.hypot(sm.x - this.anchor.x, sm.y - this.anchor.y); if (da >= 10) { this.distance += da; this.anchor = { x: sm.x, y: sm.y }; } }
      const out = [];
      if (gap || !this.last) { this.last = { x: sm.x, y: sm.y }; out.push({ x: sm.x, y: sm.y, t, brk: true }); return out; }
      let L = Math.hypot(sm.x - this.last.x, sm.y - this.last.y);
      if (L >= STEP) {
        const ux = (sm.x - this.last.x) / L, uy = (sm.y - this.last.y) / L;
        while (L >= STEP) { this.last = { x: this.last.x + ux * STEP, y: this.last.y + uy * STEP }; out.push({ x: this.last.x, y: this.last.y, t, brk: false }); L -= STEP; }
      }
      return out;
    }
  }

  // Richtung eines Abtastpunkts aus seinen Nachbarn (back/fwd Schritte), null wenn unklar
  function headingOf(samples, j, back, ahead) {
    let a = j, b = j;
    for (let k = 0; k < back && a > 0 && !samples[a].brk; k++) a--;
    for (let k = 0; k < ahead && b < samples.length - 1 && !samples[b + 1].brk; k++) b++;
    const hx = samples[b].x - samples[a].x, hy = samples[b].y - samples[a].y; const l = Math.hypot(hx, hy);
    return l >= 8 ? [hx / l, hy / l] : null;
  }

  function candidatesAt(model, cfg, smp) {
    const arr = model.grid.get(Math.floor(smp.x / CELL) * 100000 + Math.floor(smp.y / CELL));
    const out = [];
    if (!arr) return out;
    for (const i of arr) {
      const [d, s, ux, uy] = project(model.pieces[i], smp.x, smp.y);
      if (d > cfg.radius) continue;
      let ang = null, e = -0.5 * (d / cfg.sigma) ** 2;
      if (smp.h) { ang = Math.acos(Math.min(1, Math.abs(smp.h[0] * ux + smp.h[1] * uy))) * 180 / Math.PI; e -= (ang / cfg.angle0) ** 2; }
      out.push({ i, d, s, ang, e });
    }
    return out;
  }

  function isAdj(model, a, b) { return model.adj[a].includes(b); }
  // Getrennte Richtungsfahrbahnen sind in OpenStreetMap gegenläufig gezeichnet, und bei Rechtsverkehr
  // liegt die jeweils andere Fahrbahn links. Parallele Wege eines Platzes erfüllen das in aller Regel nicht.
  function isDualPair(p, q) {
    if (p.ux * q.ux + p.uy * q.uy > -0.7) return false;
    const leftOfP = p.ux * (q.my - p.my) - p.uy * (q.mx - p.mx) > 0;
    const leftOfQ = q.ux * (p.my - q.my) - q.uy * (p.mx - q.mx) > 0;
    return leftOfP && leftOfQ;
  }
  // gemeinsamer Punkt zweier benachbarter Abschnitte: [Position entlang a, Position entlang b]
  function sharedS(model, a, b) {
    const A = model.pieces[a], B = model.pieces[b];
    for (let i = 0; i < A.xy.length; i += 2) {
      const kx = Math.round(A.xy[i] * 2), ky = Math.round(A.xy[i + 1] * 2);
      for (let j = 0; j < B.xy.length; j += 2) {
        if (Math.round(B.xy[j] * 2) === kx && Math.round(B.xy[j + 1] * 2) === ky) return [A.cum[i / 2], B.cum[j / 2]];
      }
    }
    return null;
  }
  function twoHop(model, a, b) { for (const x of model.adj[a]) if (model.adj[x].includes(b)) return x; return -1; }

  function transition(model, cfg, a, b, brk) {
    if (brk) return a === b ? 0 : cfg.tBreak;
    if (a === OFF || b === OFF) return a === b ? 0 : cfg.offTrans;
    if (a === b) return cfg.tSame;
    const pa = model.pieces[a], pb = model.pieces[b];
    if (isAdj(model, a, b)) return pa.s === pb.s ? cfg.tAdjSame : cfg.tAdjOther;
    if (twoHop(model, a, b) >= 0) return cfg.tTwoHop;
    return cfg.tJump;
  }

  // Viterbi-Schritt: liefert {states, cands, score, back}
  function hmmStep(model, cfg, prev, smp) {
    const cands = candidatesAt(model, cfg, smp);
    const states = [OFF].concat(cands.map(c => c.i));
    const emit = [cfg.offEmit].concat(cands.map(c => c.e));
    const score = new Float64Array(states.length), back = new Int32Array(states.length);
    for (let k = 0; k < states.length; k++) {
      if (!prev) { score[k] = emit[k]; back[k] = -1; continue; }
      let best = -Infinity, bi = 0;
      for (let q = 0; q < prev.states.length; q++) {
        const v = prev.score[q] + transition(model, cfg, prev.states[q], states[k], smp.brk);
        if (v > best) { best = v; bi = q; }
      }
      score[k] = best + emit[k]; back[k] = bi;
    }
    // Normieren gegen Unterlauf
    let mx = -Infinity; for (const v of score) if (v > mx) mx = v;
    for (let k = 0; k < score.length; k++) score[k] -= mx;
    return { smp, states, cands, score, back };
  }

  // Gutschrift entlang des gefundenen Wegs
  class Creditor {
    constructor(model, visited, cfg) { this.m = model; this.v = visited; this.cfg = cfg; this.span = new Map(); this.newPieces = []; this.prevState = OFF; }
    _touch(i, s, fresh) {
      if (this.v[i]) return;
      let sp = this.span.get(i);
      if (!sp) this.span.set(i, sp = [s, s]); else { if (s < sp[0]) sp[0] = s; if (s > sp[1]) sp[1] = s; }
      const p = this.m.pieces[i];
      if (sp[1] - sp[0] >= Math.min(10, 0.5 * p.len)) this._credit(i, fresh);
    }
    _credit(i, fresh) { if (this.v[i]) return; this.v[i] = 1; this.newPieces.push(i); fresh.push(i); this.span.delete(i); }
    // step = Ergebnis von hmmStep, k = gewählter Zustand
    add(step, k, fresh) {
      const st = step.states[k];
      if (st !== OFF) {
        const c = step.cands[k - 1];
        this._touch(st, c.s, fresh);
        const p = this.m.pieces[st];
        if (this.prevState !== OFF && this.prevState !== st && !step.smp.brk) {
          if (isAdj(this.m, this.prevState, st)) {
            // Übergang über den gemeinsamen Punkt: beide Abschnitte bis dorthin gelaufen
            const sh = sharedS(this.m, this.prevState, st);
            if (sh) { this._touch(this.prevState, sh[0], fresh); this._touch(st, sh[1], fresh); }
          } else {
            // Lücke über genau einen Abschnitt schließen
            // (z. B. wenn das GPS an einer Ecke abkürzt)
            const mid = twoHop(this.m, this.prevState, st);
            if (mid >= 0) this._credit(mid, fresh);
          }
        }
        // Gegenfahrbahn derselben Straße (getrennte Richtungsfahrbahnen)
        for (const o of step.cands) {
          if (o.i === st || this.m.pieces[o.i].s !== p.s || o.d > this.cfg.tol * 1.5) continue;
          if (o.ang == null || o.ang > 30 || !isDualPair(p, this.m.pieces[o.i])) continue;
          this._touch(o.i, o.s, fresh);
        }
      }
      this.prevState = st;
    }
  }

  // Nachträglicher Abgleich einer ganzen Spur (genaueste Variante)
  function processTrack(model, visited, points, opts) {
    const cfg = settings(opts);
    const rs = new Resampler(cfg);
    const samples = [];
    for (const q of points) { const out = rs.add(q[0], q[1], q[2], q[3]); if (out) for (const s of out) samples.push(s); }
    for (let j = 0; j < samples.length; j++) samples[j].h = headingOf(samples, j, 2, 2);
    const steps = []; let prev = null;
    for (const smp of samples) { prev = hmmStep(model, cfg, smp.brk ? (prev ? collapse(prev) : null) : prev, smp); steps.push(prev); }
    const path = new Array(steps.length);
    if (steps.length) {
      let k = argmax(steps[steps.length - 1].score);
      for (let j = steps.length - 1; j >= 0; j--) { path[j] = k; k = steps[j].back[k]; if (k < 0) k = 0; }
    }
    const cr = new Creditor(model, visited, cfg); const fresh = [];
    for (let j = 0; j < steps.length; j++) cr.add(steps[j], path[j], fresh);
    return { newPieces: cr.newPieces, distance: rs.distance, samples: samples.length, path: steps.map((s, j) => s.states[path[j]]) };
  }
  // nach einer Lücke: alter Weg endet im besten Zustand
  function collapse(step) { const k = argmax(step.score); return { smp: step.smp, states: [step.states[k]], cands: [], score: new Float64Array([0]), back: new Int32Array([0]) }; }
  function argmax(a) { let bi = 0; for (let k = 1; k < a.length; k++) if (a[k] > a[bi]) bi = k; return bi; }

  // Live-Abgleich während des Spaziergangs: Entscheidung mit kurzer Verzögerung (LAG Abtastpunkte)
  class LiveMatcher {
    constructor(model, visited, opts) {
      this.m = model; this.cfg = settings(opts);
      this.rs = new Resampler(this.cfg);
      this.cr = new Creditor(model, visited, this.cfg);
      this.LAG = 5;
      this.samples = []; this.steps = []; this.committed = 0;
    }
    get distance() { return this.rs.distance; }
    get newPieces() { return this.cr.newPieces; }
    // liefert {accepted, nearest:{i,dist}|null, fresh:[pieceIdx]}
    add(lat, lon, t, acc) {
      const res = { accepted: false, nearest: null, fresh: [] };
      const out = this.rs.add(lat, lon, t, acc);
      if (!out) return res;
      res.accepted = true;
      for (const smp of out) {
        this.samples.push(smp);
        const n = this.samples.length - 1;
        smp.h = headingOf(this.samples, n, 3, 0);
        const prev = this.steps.length ? this.steps[this.steps.length - 1] : null;
        this.steps.push(hmmStep(this.m, this.cfg, smp.brk ? (prev ? collapse(prev) : null) : prev, smp));
        this._commit(res.fresh, false);
      }
      const last = this.steps[this.steps.length - 1];
      if (last) {
        const k = argmax(last.score);
        if (last.states[k] !== OFF) res.nearest = { i: last.states[k], dist: last.cands[k - 1].d };
      }
      return res;
    }
    _commit(fresh, all) {
      const n = this.steps.length - 1;
      const upto = all ? n : n - this.LAG;
      if (upto < this.committed) return;
      // Rückverfolgung vom aktuell besten Zustand
      let k = argmax(this.steps[n].score);
      const path = [];
      for (let j = n; j >= this.committed; j--) { path[j] = k; k = this.steps[j].back[k]; if (k < 0) k = 0; }
      for (let j = this.committed; j <= upto; j++) this.cr.add(this.steps[j], path[j], fresh);
      this.committed = upto + 1;
      // Speicher begrenzen
      if (this.committed > 200) { const cut = this.committed - 50; this.steps.splice(0, cut); this.samples.splice(0, cut); this.committed -= cut; }
    }
    flush() { const fresh = []; if (this.steps.length) this._commit(fresh, true); return fresh; }
  }

  // ---------- Auswertung ----------
  function computeStats(model, visited, opts) {
    const withPaths = !!(opts && opts.includePaths);
    const level = (opts && opts.level) || model.defaultLevel;
    const dList = level ? model.data.levels[level] : [];
    const streets = model.data.streets;
    const sTot = new Float64Array(streets.length), sDone = new Float64Array(streets.length);
    const dTot = new Float64Array(dList.length), dDone = new Float64Array(dList.length);
    let tot = 0, done = 0;
    for (let i = 0; i < model.pieces.length; i++) {
      const p = model.pieces[i];
      if (p.c === 'w' && !withPaths) continue;
      tot += p.len; sTot[p.s] += p.len;
      const di = level ? p.d[level] : -1;
      if (di >= 0) dTot[di] += p.len;
      if (visited[i]) { done += p.len; sDone[p.s] += p.len; if (di >= 0) dDone[di] += p.len; }
    }
    // Straßen je Bezirk (Mehrheit der Länge)
    const sDist = new Int32Array(streets.length).fill(-1);
    if (level) {
      const acc = new Map();
      for (const p of model.pieces) {
        if (p.c === 'w' && !withPaths) continue;
        const di = p.d[level]; if (di < 0) continue;
        const key = p.s * 1000 + di; acc.set(key, (acc.get(key) || 0) + p.len);
      }
      const best = new Float64Array(streets.length);
      for (const [key, len] of acc) { const s = Math.floor(key / 1000), di = key % 1000; if (len > best[s]) { best[s] = len; sDist[s] = di; } }
    }
    let nStreets = 0, nDone = 0, nStarted = 0;
    const dStreets = dList.map(() => ({ n: 0, done: 0 }));
    for (let s = 0; s < streets.length; s++) {
      if (sTot[s] <= 0) continue;
      nStreets++;
      const isDone = sDone[s] / sTot[s] >= DONE_SHARE;
      if (isDone) nDone++; else if (sDone[s] > 0) nStarted++;
      if (sDist[s] >= 0) { dStreets[sDist[s]].n++; if (isDone) dStreets[sDist[s]].done++; }
    }
    return {
      totalM: tot, doneM: done, share: tot ? done / tot : 0,
      streets: { total: nStreets, done: nDone, started: nStarted },
      streetTot: sTot, streetDone: sDone,
      level,
      districts: dList.map((d, i) => ({ i, name: d.name, totalM: dTot[i], doneM: dDone[i], share: dTot[i] ? dDone[i] / dTot[i] : 0, streets: dStreets[i] }))
    };
  }

  function streetShare(stats, s) { return stats.streetTot[s] ? stats.streetDone[s] / stats.streetTot[s] : 0; }

  // ---------- GPX ----------
  function parseGpx(text) {
    const pts = [];
    const re = /<(?:trkpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:trkpt|rtept)>)/g;
    let m;
    while ((m = re.exec(text))) {
      const attrs = m[1];
      const la = /lat\s*=\s*["']([-\d.eE]+)["']/.exec(attrs), lo = /lon\s*=\s*["']([-\d.eE]+)["']/.exec(attrs);
      if (!la || !lo) continue;
      let t = null;
      if (m[3]) { const tm = /<time>([^<]+)<\/time>/.exec(m[3]); if (tm) { const v = Date.parse(tm[1]); if (!isNaN(v)) t = v; } }
      pts.push([+la[1], +lo[1], t, null]);
    }
    const nameM = /<name>([^<]*)<\/name>/.exec(text);
    return { name: nameM ? nameM[1].trim() : null, points: pts };
  }

  const api = { fwd, inv, overpassQuery, compactFromOverpass, buildModel, LiveMatcher, Matcher: LiveMatcher, processTrack, computeStats, streetShare, parseGpx, project, Poly, DONE_SHARE, PIECE_LEN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StreetCore = api;
})(typeof self !== 'undefined' ? self : this);
