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
    return '[out:json][timeout:180];' +
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
    data.ways.forEach((w, wi) => {
      const xy = w.g.map(p => fwd(p[0], p[1]));
      const cum = [0];
      for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
      const L = cum[cum.length - 1];
      if (L < 1) return;
      const n = Math.max(1, Math.round(L / PIECE_LEN));
      const step = L / n;
      let vi = 0;
      for (let k = 0; k < n; k++) {
        const a = k * step, b = (k + 1) * step;
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
        const p = { w: w.id, wi, k, s: w.s, c: w.c, len, xy: flat, cum: c, mx: mid[0], my: mid[1], d: {} };
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

    // Bezirksebene wählen: die mit Anzahl am nächsten an 13 (Würzburgs Stadtbezirke)
    const lvlKeys = Object.keys(data.levels).filter(k => data.levels[k].length > 1);
    lvlKeys.sort((a, b) => Math.abs(data.levels[a].length - 13) - Math.abs(data.levels[b].length - 13));

    return { data, pieces, grid, cityPoly, defaultLevel: lvlKeys[0] || null, levelsAvailable: lvlKeys };
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

  // Abstand Punkt → Abschnitt, mit Position entlang des Abschnitts
  function project(p, x, y) {
    const f = p.xy; let best = Infinity, bestS = 0;
    for (let j = 0; j + 3 < f.length; j += 2) {
      const ax = f[j], ay = f[j + 1], bx = f[j + 2], by = f[j + 3];
      const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t, qy = ay + dy * t;
      const d = Math.hypot(x - qx, y - qy);
      if (d < best) { best = d; bestS = p.cum[j / 2] + Math.sqrt(l2) * t; }
    }
    return [best, bestS];
  }

  // ---------- Abgleich einer Spur (live oder nachträglich) ----------
  class Matcher {
    constructor(model, visited, opts) {
      this.m = model; this.v = visited;
      this.R = (opts && opts.tolerance) || 20;
      this.maxAcc = (opts && opts.maxAccuracy) || 35;
      this.span = new Map(); // piece -> [smin, smax]
      this.prev = null;      // letzter akzeptierter Punkt {x,y,t}
      this.anchor = null;    // Bezugspunkt für die Streckenlänge (glättet GPS-Zittern)
      this.distance = 0;
      this.newPieces = [];
    }
    // liefert {accepted, nearest:{i,dist}|null, fresh:[pieceIdx]}
    add(lat, lon, t, acc) {
      const res = { accepted: false, nearest: null, fresh: [] };
      if (acc != null && acc > this.maxAcc) return res;
      const [x, y] = fwd(lat, lon);
      const prev = this.prev;
      if (prev) {
        const d = Math.hypot(x - prev.x, y - prev.y);
        const dt = (t != null && prev.t != null) ? (t - prev.t) / 1000 : null;
        if (dt != null && dt > 0 && d / dt > 12 && d > 50) return res; // GPS-Sprung
        if (d < 2) { // Stillstand: nur Status aktualisieren
          res.accepted = true; res.nearest = this._match(x, y, res.fresh); return res;
        }
        if (d <= 150 && (dt == null || dt <= 180)) {
          const steps = Math.floor(d / 4);
          for (let k = 1; k < steps; k++) this._match(prev.x + (x - prev.x) * k / steps, prev.y + (y - prev.y) * k / steps, res.fresh);
        }
      }
      res.nearest = this._match(x, y, res.fresh);
      this.prev = { x, y, t };
      const sm = this.smooth = this.smooth ? { x: this.smooth.x + 0.35 * (x - this.smooth.x), y: this.smooth.y + 0.35 * (y - this.smooth.y) } : { x, y };
      if (!this.anchor) this.anchor = { x: sm.x, y: sm.y };
      else { const da = Math.hypot(sm.x - this.anchor.x, sm.y - this.anchor.y); if (da >= 10) { this.distance += da; this.anchor = { x: sm.x, y: sm.y }; } }
      res.accepted = true;
      return res;
    }
    _match(x, y, fresh) {
      const arr = this.m.grid.get(Math.floor(x / CELL) * 100000 + Math.floor(y / CELL));
      if (!arr) return null;
      let near = null;
      for (const i of arr) {
        const p = this.m.pieces[i];
        const [d, s] = project(p, x, y);
        if (d > this.R) continue;
        if (!near || d < near.dist) near = { i, dist: d };
        if (this.v[i]) continue;
        let sp = this.span.get(i);
        if (!sp) this.span.set(i, sp = [s, s]); else { if (s < sp[0]) sp[0] = s; if (s > sp[1]) sp[1] = s; }
        if (sp[1] - sp[0] >= Math.min(10, 0.6 * p.len)) {
          this.v[i] = 1; this.newPieces.push(i); fresh.push(i); this.span.delete(i);
        }
      }
      return near;
    }
  }

  function processTrack(model, visited, points, opts) {
    const mt = new Matcher(model, visited, opts);
    for (const q of points) mt.add(q[0], q[1], q[2], q[3]);
    return { newPieces: mt.newPieces, distance: mt.distance };
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

  const api = { fwd, inv, overpassQuery, compactFromOverpass, buildModel, Matcher, processTrack, computeStats, streetShare, parseGpx, project, Poly, DONE_SHARE, PIECE_LEN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StreetCore = api;
})(typeof self !== 'undefined' ? self : this);
