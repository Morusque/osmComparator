/*
 * viewer.js — rendering engine. You normally don't need to touch this file;
 * add your analyses in analyses.js instead.
 */
"use strict";

/* ------------------------------ helpers ------------------------------- */

// blue -> cyan -> yellow -> red ramp, clamped
function heat(v, min, max) {
  let t = (v - min) / (max - min);
  t = Math.max(0, Math.min(1, t));
  const hue = 240 - 240 * t;
  return `hsl(${hue.toFixed(0)},85%,55%)`;
}

const _catCache = {};
const _catPalette = ["#60a5fa", "#f87171", "#4ade80", "#fbbf24", "#c084fc",
  "#f472b6", "#2dd4bf", "#fb923c", "#a3e635", "#818cf8", "#e879f9", "#facc15",
  "#34d399", "#fda4af", "#7dd3fc", "#d6b88a"];
let _catNext = 0;
function catColor(s) {
  if (!(s in _catCache)) _catCache[s] = _catPalette[_catNext++ % _catPalette.length];
  return _catCache[s];
}

function fmtVal(v, unit) {
  if (unit === "m") return v >= 10000 ? (v / 1000).toFixed(1) + " km" : Math.round(v) + " m";
  if (unit === "m2") return v >= 100000 ? (v / 1e6).toFixed(2) + " km²" : Math.round(v).toLocaleString() + " m²";
  if (unit === "pct") return v.toFixed(2) + " %";
  return Math.round(v).toLocaleString();
}

// "shop" | "amenity=restaurant" | "amenity=restaurant|cafe"
function parseFilter(str) {
  str = (str || "").trim();
  if (!str) return null;
  const i = str.indexOf("=");
  if (i < 0) return { key: str, values: null, label: str };
  const key = str.slice(0, i).trim();
  const vals = str.slice(i + 1).split("|").map((s) => s.trim()).filter(Boolean);
  return { key, values: vals.length ? new Set(vals) : null, label: str };
}
function currentFilter() {
  return parseFilter(document.getElementById("filter-input").value);
}
function matchesFilter(f, flt) {
  const v = f.t[flt.key];
  return v !== undefined && (!flt.values || flt.values.has(v));
}

// A clicked Compare row sets this to a metric's own match function, which can
// be arbitrary (compound, length-based) and isn't expressible as a text
// filter. Typing in the filter box clears it (see init).
let activeMetricMatch = null; // {label, match}

// What the Highlight / Density modes should match: the clicked metric if any,
// otherwise the text filter box. Returns {label, test(f)} or null.
function currentMatcher() {
  if (activeMetricMatch)
    return { label: activeMetricMatch.label, test: activeMetricMatch.match };
  const flt = currentFilter();
  if (!flt) return null;
  return { label: flt.label, test: (f) => matchesFilter(f, flt) };
}

/* ------------------------------ datasets ------------------------------ */

const Datasets = {}; // name -> processed dataset
const PANES = [];

function processDataset(raw) {
  const features = [];
  for (const w of raw.ways) {
    const xy = w.xy;
    const path = new Path2D();
    path.moveTo(xy[0], xy[1]);
    let minx = xy[0], maxx = xy[0], miny = xy[1], maxy = xy[1];
    for (let i = 2; i < xy.length; i += 2) {
      path.lineTo(xy[i], xy[i + 1]);
      if (xy[i] < minx) minx = xy[i]; if (xy[i] > maxx) maxx = xy[i];
      if (xy[i + 1] < miny) miny = xy[i + 1]; if (xy[i + 1] > maxy) maxy = xy[i + 1];
    }
    if (w.closed) path.closePath();
    features.push({ kind: "way", t: w.t, len: w.len, area: w.area,
      closed: !!w.closed, path, bbox: [minx, miny, maxx, maxy],
      cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 });
  }
  for (const p of raw.points)
    features.push({ kind: "point", t: p.t, x: p.x, y: p.y });
  for (const r of raw.relations)
    features.push({ kind: "relation", t: r.t });

  // data extent (from ways+points)
  let minx = 1e12, miny = 1e12, maxx = -1e12, maxy = -1e12;
  for (const f of features) {
    if (f.kind === "way") {
      minx = Math.min(minx, f.bbox[0]); miny = Math.min(miny, f.bbox[1]);
      maxx = Math.max(maxx, f.bbox[2]); maxy = Math.max(maxy, f.bbox[3]);
    } else if (f.kind === "point") {
      minx = Math.min(minx, f.x); miny = Math.min(miny, f.y);
      maxx = Math.max(maxx, f.x); maxy = Math.max(maxy, f.y);
    }
  }
  const b = raw.bounds_m;
  const boundsKm2 = b ? ((b[2] - b[0]) * (b[3] - b[1])) / 1e6
                      : ((maxx - minx) * (maxy - miny)) / 1e6;
  // fit to the export bbox, not the data extent: exports often drag in
  // far-away members of boundary relations
  const extent = b ? [b[0], b[1], b[2], b[3]] : [minx, miny, maxx, maxy];
  return { name: raw.name, features, extent, boundsKm2, center: raw.center };
}

/* ---------------------- in-browser .osm parsing ----------------------- */
/* Mirrors prepare.py so files can be drag-and-dropped onto a pane.       */

const M_PER_DEG_LAT = 111320;

function parseOsmText(text, name) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("not valid XML");
  const root = doc.documentElement;
  if (root.tagName !== "osm") throw new Error("not an OSM file");

  const nodes = new Map();
  const rawPoints = [], rawWays = [], rawRels = [];
  let bounds = null;

  const readTags = (el) => {
    const t = {};
    for (const c of el.children)
      if (c.tagName === "tag") t[c.getAttribute("k")] = c.getAttribute("v");
    return t;
  };

  for (const el of root.children) {
    const tag = el.tagName;
    if (tag === "bounds") {
      bounds = [+el.getAttribute("minlat"), +el.getAttribute("minlon"),
                +el.getAttribute("maxlat"), +el.getAttribute("maxlon")];
    } else if (tag === "node") {
      const lat = +el.getAttribute("lat"), lon = +el.getAttribute("lon");
      nodes.set(+el.getAttribute("id"), [lat, lon]);
      const t = readTags(el);
      if (Object.keys(t).length) rawPoints.push([lat, lon, t]);
    } else if (tag === "way") {
      const refs = [];
      for (const c of el.children)
        if (c.tagName === "nd") refs.push(+c.getAttribute("ref"));
      rawWays.push({ id: +el.getAttribute("id"), refs, t: readTags(el) });
    } else if (tag === "relation") {
      const t = readTags(el);
      if (!Object.keys(t).length) continue;
      const ways = [];
      for (const c of el.children)
        if (c.tagName === "member" && c.getAttribute("type") === "way")
          ways.push(+c.getAttribute("ref"));
      rawRels.push({ id: +el.getAttribute("id"), t, ways });
    }
  }
  if (!nodes.size) throw new Error("no nodes found");

  let lat0, lon0;
  if (bounds) {
    lat0 = (bounds[0] + bounds[2]) / 2; lon0 = (bounds[1] + bounds[3]) / 2;
  } else {
    lat0 = 0; lon0 = 0;
    for (const [la, lo] of nodes.values()) { lat0 += la; lon0 += lo; }
    lat0 /= nodes.size; lon0 /= nodes.size;
  }
  const mLon = M_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);
  const px = (lat, lon) => [(lon - lon0) * mLon, (lat - lat0) * M_PER_DEG_LAT];

  const relWayIds = new Set();
  for (const r of rawRels) for (const w of r.ways) relWayIds.add(w);

  const ways = [];
  for (const w of rawWays) {
    if (!Object.keys(w.t).length && !relWayIds.has(w.id)) continue;
    const xy = [];
    for (const ref of w.refs) {
      const ll = nodes.get(ref);
      if (ll) { const [x, y] = px(ll[0], ll[1]); xy.push(x, y); }
    }
    if (xy.length < 4) continue;
    const closed = w.refs[0] === w.refs[w.refs.length - 1] && w.refs.length >= 4;
    let len = 0, area2 = 0;
    for (let i = 0; i + 3 < xy.length; i += 2) {
      len += Math.hypot(xy[i + 2] - xy[i], xy[i + 3] - xy[i + 1]);
      area2 += xy[i] * xy[i + 3] - xy[i + 2] * xy[i + 1];
    }
    const entry = { id: w.id, xy, t: w.t, len };
    if (closed) { entry.closed = 1; entry.area = Math.abs(area2) / 2; }
    ways.push(entry);
  }

  let bounds_m = null;
  if (bounds) {
    const [x1, y1] = px(bounds[0], bounds[1]);
    const [x2, y2] = px(bounds[2], bounds[3]);
    bounds_m = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  }

  return {
    name, center: [lat0, lon0], bounds_m,
    points: rawPoints.map(([la, lo, t]) => { const [x, y] = px(la, lo); return { x, y, t }; }),
    ways, relations: rawRels,
  };
}

function refreshDatasetOptions() {
  for (const pane of PANES) {
    const cur = pane.dsSelect.value;
    pane.dsSelect.innerHTML = "";
    for (const name of Object.keys(Datasets).sort((a, b) => a.localeCompare(b))) {
      const o = document.createElement("option");
      o.value = name; o.textContent = name;
      pane.dsSelect.appendChild(o);
    }
    pane.dsSelect.value = pane.ds ? pane.ds.name : cur;
  }
}

/* ------------------------------ MapView ------------------------------- */

class MapView {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.dsSelect = root.querySelector(".ds-select");
    this.anSelect = root.querySelector(".an-select");
    this.status = root.querySelector(".status");
    this.tooltip = root.querySelector(".tooltip");
    this.ds = null;
    this.analysisKey = "map";
    this.view = { scale: 1, cx: 0, cy: 0 }; // scale: px per meter, c*: world center

    for (const key of Object.keys(ANALYSES)) {
      const o = document.createElement("option");
      o.value = key; o.textContent = ANALYSES[key].label || key;
      this.anSelect.appendChild(o);
    }
    this.dsSelect.onchange = () => this.setDataset(this.dsSelect.value);
    this.anSelect.onchange = () => { this.analysisKey = this.anSelect.value; this.draw(); };

    this._bindInteraction();
    this._bindDrop();
    new ResizeObserver(() => this._resize()).observe(this.canvas);
    this._resize();
  }

  setDataset(name) {
    this.ds = Datasets[name];
    this.dsSelect.value = name;
    this.fit();
  }

  fit() {
    if (!this.ds) return;
    const [minx, miny, maxx, maxy] = this.ds.extent;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.view.scale = Math.min(w / (maxx - minx), h / (maxy - miny)) * 0.95;
    this.view.cx = (minx + maxx) / 2;
    this.view.cy = (miny + maxy) / 2;
    this.draw();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.draw();
  }

  // world <-> screen (CSS px)
  w2s(x, y) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return [(x - this.view.cx) * this.view.scale + w / 2,
            -(y - this.view.cy) * this.view.scale + h / 2];
  }
  s2w(px, py) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return [(px - w / 2) / this.view.scale + this.view.cx,
            -(py - h / 2) / this.view.scale + this.view.cy];
  }

  _applyTransform() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const s = this.view.scale;
    this.ctx.setTransform(s * dpr, 0, 0, -s * dpr,
      dpr * (w / 2 - this.view.cx * s), dpr * (h / 2 + this.view.cy * s));
  }

  draw() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#15171c";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.ds) return;

    const analysis = ANALYSES[this.analysisKey];
    const s = this.view.scale;
    // visible world rect (with margin)
    const [wx1, wy2] = this.s2w(-50, -50);
    const [wx2, wy1] = this.s2w(this.canvas.clientWidth + 50, this.canvas.clientHeight + 50);

    // bucket by z
    const buckets = [];
    const pts = [];
    let drawn = 0;
    for (const f of this.ds.features) {
      if (f.kind === "relation") continue;
      if (f.kind === "way") {
        const bb = f.bbox;
        if (bb[2] < wx1 || bb[0] > wx2 || bb[3] < wy1 || bb[1] > wy2) continue;
      } else if (f.x < wx1 || f.x > wx2 || f.y < wy1 || f.y > wy2) continue;
      const st = analysis.style(f);
      if (!st) continue;
      drawn++;
      const z = st.z || 0;
      if (f.kind === "point") pts.push([f, st, z]);
      else (buckets[z] = buckets[z] || []).push([f, st]);
    }

    this._applyTransform();
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (let z = 0; z < buckets.length; z++) {
      if (!buckets[z]) continue;
      for (const [f, st] of buckets[z]) {
        if (st.fill && f.closed) { ctx.fillStyle = st.fill; ctx.fill(f.path); }
        const strokeC = st.stroke || (st.fill && !f.closed ? st.fill : null);
        if (strokeC) {
          ctx.strokeStyle = strokeC;
          ctx.lineWidth = (st.width || 1) / s;
          ctx.stroke(f.path);
        }
      }
    }
    // points on top, in screen-size radius
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const [f, st] of pts.sort((a, b) => a[2] - b[2])) {
      const [px, py] = this.w2s(f.x, f.y);
      ctx.fillStyle = st.fill || "#fff";
      ctx.beginPath();
      ctx.arc(px, py, st.r || 2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (analysis.overlay) analysis.overlay(this);

    this._drawScaleBar();
    this._drawLegend(analysis.legend);
    this.status.textContent =
      `${this.ds.name} — ${drawn.toLocaleString()} features drawn — ` +
      `bounds ≈ ${this.ds.boundsKm2.toFixed(1)} km²`;
  }

  _drawScaleBar() {
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    const targetPx = 100;
    const meters = targetPx / this.view.scale;
    const nice = Math.pow(10, Math.floor(Math.log10(meters)));
    const m = meters / nice >= 5 ? 5 * nice : meters / nice >= 2 ? 2 * nice : nice;
    const px = m * this.view.scale;
    const h = this.canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "rgba(20,22,28,.7)";
    ctx.fillRect(8, h - 30, px + 16, 22);
    ctx.strokeStyle = "#ddd"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(16, h - 14); ctx.lineTo(16 + px, h - 14); ctx.stroke();
    ctx.fillStyle = "#ddd"; ctx.font = "11px sans-serif";
    ctx.fillText(m >= 1000 ? (m / 1000) + " km" : m + " m", 16, h - 18);
  }

  _drawLegend(legend) {
    if (!legend) return;
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = 140, x = this.canvas.clientWidth - w - 12, y = 12;
    ctx.fillStyle = "rgba(20,22,28,.8)";
    ctx.fillRect(x - 6, y - 4, w + 12, 34);
    for (let i = 0; i < w; i++) {
      ctx.fillStyle = heat(i, 0, w);
      ctx.fillRect(x + i, y, 1, 10);
    }
    ctx.fillStyle = "#ddd"; ctx.font = "10px sans-serif";
    ctx.fillText(`${legend.min}${legend.log ? " (log)" : ""}`, x, y + 22);
    const maxLabel = `${legend.max} ${legend.unit || ""}`;
    ctx.fillText(maxLabel, x + w - ctx.measureText(maxLabel).width, y + 22);
  }

  _bindInteraction() {
    const cv = this.canvas;
    let dragging = false, lastX = 0, lastY = 0;

    cv.addEventListener("pointerdown", (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", (e) => {
      if (dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        this.view.cx -= dx / this.view.scale;
        this.view.cy += dy / this.view.scale;
        lastX = e.clientX; lastY = e.clientY;
        this.tooltip.style.display = "none";
        requestAnimationFrame(() => this.draw());
      } else {
        this._hover(e);
      }
    });
    cv.addEventListener("pointerup", () => { dragging = false; });
    cv.addEventListener("dblclick", () => this.fit());
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const [wx, wy] = this.s2w(mx, my);
      const k = e.deltaY < 0 ? 1.25 : 0.8;
      this.view.scale *= k;
      // keep the point under the cursor fixed
      const [nx, ny] = this.s2w(mx, my);
      this.view.cx += wx - nx; this.view.cy += wy - ny;
      requestAnimationFrame(() => this.draw());
    }, { passive: false });
    cv.addEventListener("pointerleave", () => { this.tooltip.style.display = "none"; });
  }

  _bindDrop() {
    const wrap = this.root.querySelector(".canvas-wrap");
    wrap.addEventListener("dragover", (e) => {
      e.preventDefault(); wrap.classList.add("drag");
    });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("drag"));
    wrap.addEventListener("drop", async (e) => {
      e.preventDefault(); wrap.classList.remove("drag");
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      this.status.textContent = `Parsing ${file.name} … (big files take a few seconds)`;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
      try {
        const text = await file.text();
        let name = file.name.replace(/\.osm$/i, "");
        while (Datasets[name]) name += "+";
        Datasets[name] = processDataset(parseOsmText(text, name));
        refreshDatasetOptions();
        this.setDataset(name);
        this.status.textContent += " — loaded (this session only; run prepare.py to keep it)";
      } catch (err) {
        this.status.textContent = `Could not load ${file.name}: ${err.message}`;
      }
    });
  }

  _hover(e) {
    if (!this.ds) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const [wx, wy] = this.s2w(mx, my);
    const tolM = 6 / this.view.scale; // 6 px in meters
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    this._applyTransform();

    let hit = null;
    // points first (smaller targets, drawn on top)
    for (const f of this.ds.features) {
      if (f.kind !== "point") continue;
      if (Math.abs(f.x - wx) < tolM && Math.abs(f.y - wy) < tolM) { hit = f; break; }
    }
    if (!hit) {
      const px = mx * dpr, py = my * dpr;
      let best = null, bestArea = Infinity;
      for (const f of this.ds.features) {
        if (f.kind !== "way" || !Object.keys(f.t).length) continue;
        const bb = f.bbox;
        if (wx < bb[0] - tolM || wx > bb[2] + tolM || wy < bb[1] - tolM || wy > bb[3] + tolM) continue;
        ctx.lineWidth = tolM * 2;
        if (ctx.isPointInStroke(f.path, px, py)) { hit = f; break; }
        if (f.closed && ctx.isPointInPath(f.path, px, py)) {
          // prefer the smallest containing polygon (building inside landuse)
          if (f.area < bestArea) { best = f; bestArea = f.area; }
        }
      }
      if (!hit) hit = best;
    }

    if (hit) {
      const lines = Object.entries(hit.t).map(([k, v]) => `<b>${k}</b> = ${v}`);
      if (hit.kind === "way") {
        lines.push(`<i>len ${fmtVal(hit.len, "m")}${hit.closed ? ", area " + fmtVal(hit.area, "m2") : ""}</i>`);
      }
      this.tooltip.innerHTML = lines.join("<br>");
      this.tooltip.style.display = "block";
      this.tooltip.style.left = Math.min(mx + 14, r.width - 240) + "px";
      this.tooltip.style.top = (my + 14) + "px";
    } else {
      this.tooltip.style.display = "none";
    }
  }
}

/* -------------------- sortable table infrastructure ------------------- */
/*
 * cols: [{label, get(row), fmt?(value,row), str?}] — get returns the sort
 * value (number unless str). Click a header to sort (first click: desc).
 * Rows may carry row._cls ("warn"/"bad") for coloring.
 */

let _tbl = null;

function showTable(cols, rows, note) {
  _tbl = { cols, rows, sort: null, note: note || "" };
  _renderTable();
}

function _renderTable() {
  const { cols, rows, sort, note } = _tbl;
  let rs = rows;
  if (sort) {
    const c = cols[sort.i];
    rs = rows.slice().sort((a, b) => {
      let va = c.get(a), vb = c.get(b);
      if (c.str) return String(va).localeCompare(String(vb)) * sort.dir;
      va = (typeof va !== "number" || isNaN(va)) ? -Infinity : va;
      vb = (typeof vb !== "number" || isNaN(vb)) ? -Infinity : vb;
      return (va - vb) * sort.dir || 0;
    });
  }
  let html = "<table><tr>" + cols.map((c, i) =>
    `<th class="sortable" onclick="_sortTable(${i})">${c.label}` +
    (sort && sort.i === i ? (sort.dir > 0 ? " ▲" : " ▼") : "") + "</th>").join("") + "</tr>";
  for (const r of rs) {
    html += `<tr class="${r._cls || ""}">` + cols.map((c) => {
      const v = c.get(r);
      return `<td>${c.fmt ? c.fmt(v, r) : v}</td>`;
    }).join("") + "</tr>";
  }
  html += "</table>" + note;
  const panel = document.getElementById("panel");
  panel.style.display = "block";
  panel.innerHTML = html;
}

window._sortTable = (i) => {
  if (_tbl.sort && _tbl.sort.i === i) _tbl.sort.dir *= -1;
  else _tbl.sort = { i, dir: _tbl.cols[i].str ? 1 : -1 };
  _renderTable();
};

function ratioCls(ratio) {
  if (!isFinite(ratio)) return "warn";
  if (ratio < 0.25 || ratio > 4) return "bad";
  if (ratio < 0.5 || ratio > 2) return "warn";
  return "";
}

/* --------------------------- comparison table ------------------------- */

function countBuildings(ds) {
  let n = 0;
  for (const f of ds.features) if (f.t.building) n++;
  return n || 1;
}

function runComparison(dsA, dsB) {
  const rows = [];
  const bA = countBuildings(dsA), bB = countBuildings(dsB);
  for (const m of COUNT_METRICS) {
    let vA = 0, vB = 0;
    for (const f of dsA.features) if (m.match(f)) vA += m.value ? m.value(f) : 1;
    for (const f of dsB.features) if (m.match(f)) vB += m.value ? m.value(f) : 1;
    const kA = vA / bA * 1000, kB = vB / bB * 1000;
    // bipolar: an imbalance either way is flagged. "only in A" and "only in B"
    // are both extreme (red); a finite ratio is judged symmetrically by
    // ratioCls (×2 either direction = yellow, ×4 either direction = red).
    let ratio, rtxt, cls;
    if (vA === 0 && vB === 0) { ratio = NaN; rtxt = "—"; cls = ""; }
    else if (vB === 0) { ratio = Infinity; rtxt = "only in A"; cls = "bad"; }
    else if (vA === 0) { ratio = 0; rtxt = "only in B"; cls = "bad"; }
    else { ratio = kA / kB; rtxt = "×" + ratio.toFixed(2); cls = ratioCls(ratio); }
    rows.push({ m, vA, vB, dA: vA / dsA.boundsKm2, dB: vB / dsB.boundsKm2,
                kA, kB, ratio, rtxt, _cls: cls });
  }
  const u = (fn) => (v, r) => fmtVal(fn ? fn(v) : v, r.m.unit);
  const cols = [
    { label: "Metric", get: (r) => r.m.label, str: true,
      fmt: (v, r) => `<span class="clickable" title="Highlight these on both maps"` +
        ` onclick="_useMetric(${COUNT_METRICS.indexOf(r.m)})">${v}</span>` },
    { label: "A total", get: (r) => r.vA, fmt: u() },
    { label: "A /km²", get: (r) => r.dA, fmt: u() },
    { label: "A /1k bldg", get: (r) => r.kA, fmt: u() },
    { label: "B total", get: (r) => r.vB, fmt: u() },
    { label: "B /km²", get: (r) => r.dB, fmt: u() },
    { label: "B /1k bldg", get: (r) => r.kB, fmt: u() },
    { label: "ratio A÷B /1k bldg", get: (r) => r.ratio, fmt: (v, r) => r.rtxt },
  ];
  showTable(cols, rows,
    `<p class='note'><b>A</b> = ${dsA.name}, <b>B</b> = ${dsB.name}. ` +
    "<b>Click a metric name</b> to highlight those features on both maps. " +
    "Click any column header to sort. The /km² columns use the export bounding box (" +
    `${dsA.boundsKm2.toFixed(1)} vs ${dsB.boundsKm2.toFixed(1)} km² here), which may include ` +
    "empty countryside — that is why the ratio column is computed per 1000 buildings instead. " +
    "The ratio is bipolar: rows turn yellow when one map has ≥2× the other (either direction), " +
    "red at ≥4× or when a feature is present in only one map. " +
    "Beware tagging-style differences: a feature can read as “only in A/B” just because the two " +
    "maps tag the same thing differently, and counts of linear things (walls, hedges…) depend on " +
    "how mappers split ways — prefer length metrics, or check lengths in the tag explorer.</p>");
}

/* ---------------------------- area breakdown --------------------------- */
/* Total area per category of closed polygons (building=*, landuse=*, ...) */

function areaBreakdown(dsA, dsB) {
  const KEYS = ["building", "landuse", "leisure", "natural", "amenity", "water"];
  const tally = (ds) => {
    const acc = {}; // cat -> {area, n}
    for (const f of ds.features) {
      if (f.kind !== "way" || !f.closed || !f.area) continue;
      for (const k of KEYS) {
        if (f.t[k] !== undefined) {
          const cat = `${k}=${f.t[k]}`;
          (acc[cat] = acc[cat] || { area: 0, n: 0 });
          acc[cat].area += f.area; acc[cat].n++;
          break; // first matching key wins
        }
      }
    }
    return acc;
  };
  const aA = tally(dsA), aB = tally(dsB);
  const cats = [...new Set([...Object.keys(aA), ...Object.keys(aB)])];
  const rows = cats.map((cat) => {
    const a = aA[cat] || { area: 0, n: 0 }, b = aB[cat] || { area: 0, n: 0 };
    const pA = a.area / (dsA.boundsKm2 * 1e6) * 100, pB = b.area / (dsB.boundsKm2 * 1e6) * 100;
    const ratio = pB > 0 ? pA / pB : (pA > 0 ? Infinity : NaN);
    return { cat, a, b, pA, pB, ratio,
             rtxt: isFinite(ratio) ? "×" + ratio.toFixed(2) : (ratio === Infinity ? "only in A" : "missing in A"),
             _cls: ratioCls(ratio) };
  });
  rows.sort((x, y) => (y.a.area + y.b.area) - (x.a.area + x.b.area));
  const cols = [
    { label: "Category", get: (r) => r.cat, str: true },
    { label: "A area", get: (r) => r.a.area, fmt: (v) => fmtVal(v, "m2") },
    { label: "A % bbox", get: (r) => r.pA, fmt: (v) => fmtVal(v, "pct") },
    { label: "A count", get: (r) => r.a.n },
    { label: "A avg", get: (r) => r.a.n ? r.a.area / r.a.n : NaN, fmt: (v) => isNaN(v) ? "—" : fmtVal(v, "m2") },
    { label: "B area", get: (r) => r.b.area, fmt: (v) => fmtVal(v, "m2") },
    { label: "B % bbox", get: (r) => r.pB, fmt: (v) => fmtVal(v, "pct") },
    { label: "B count", get: (r) => r.b.n },
    { label: "B avg", get: (r) => r.b.n ? r.b.area / r.b.n : NaN, fmt: (v) => isNaN(v) ? "—" : fmtVal(v, "m2") },
    { label: "ratio of % bbox", get: (r) => r.ratio, fmt: (v, r) => r.rtxt },
  ];
  showTable(cols, rows,
    `<p class='note'><b>A</b> = ${dsA.name}, <b>B</b> = ${dsB.name}. ` +
    "Closed polygons only (multipolygon relations not assembled). Each polygon is counted once, " +
    "under the first matching key of: " + KEYS.join(", ") + ". " +
    "“% bbox” = share of the export bounding box covered. “avg” = mean polygon size — a good " +
    "tagging-style-independent check (do equivalent features have comparable sizes?).</p>");
}

/* ----------------------- building size histogram ----------------------- */

function buildingHistogram(dsA, dsB) {
  const LOG_MIN = 1, LOG_MAX = 4, BINS = 24; // 10 m² .. 10 000 m²
  const tally = (ds) => {
    const bins = new Array(BINS + 2).fill(0); // [under, ...bins, over]
    let total = 0;
    for (const f of ds.features) {
      if (f.kind !== "way" || !f.t.building || !f.closed || !f.area) continue;
      total++;
      const l = Math.log10(f.area);
      if (l < LOG_MIN) bins[0]++;
      else if (l >= LOG_MAX) bins[BINS + 1]++;
      else bins[1 + Math.floor((l - LOG_MIN) / (LOG_MAX - LOG_MIN) * BINS)]++;
    }
    return { bins, total: total || 1 };
  };
  const A = tally(dsA), B = tally(dsB);
  const maxShare = Math.max(...A.bins.map((v) => v / A.total), ...B.bins.map((v) => v / B.total));
  const edge = (i) => Math.round(Math.pow(10, LOG_MIN + (i - 1) * (LOG_MAX - LOG_MIN) / BINS));
  let html = `<h3>Building footprint sizes</h3>
    <p class='note'><span class="sw swA"></span> A = ${dsA.name} (${A.total} closed buildings) &nbsp;
    <span class="sw swB"></span> B = ${dsB.name} (${B.total}) — bars show the share of each map's
    buildings in that size bin (log scale), so shapes are directly comparable. A spike or offset
    means buildings are systematically the wrong size.</p><div class="hist">`;
  for (let i = 0; i < BINS + 2; i++) {
    const label = i === 0 ? "< 10 m²" : i === BINS + 1 ? "> 10 000 m²" : `${edge(i)}–${edge(i + 1)} m²`;
    const wA = (A.bins[i] / A.total) / maxShare * 100, wB = (B.bins[i] / B.total) / maxShare * 100;
    html += `<div class="hrow"><span class="hlbl">${label}</span><span class="hbars">` +
      `<span class="hbar hA" style="width:${wA.toFixed(1)}%" title="${A.bins[i]}"></span><br>` +
      `<span class="hbar hB" style="width:${wB.toFixed(1)}%" title="${B.bins[i]}"></span></span></div>`;
  }
  html += "</div>";
  const panel = document.getElementById("panel");
  panel.style.display = "block";
  panel.innerHTML = html;
}

/* ----------------------------- tag explorer --------------------------- */

function exploreTag(key, dsA, dsB) {
  const tally = (ds) => {
    const c = {}; // value -> {n, len, area}
    for (const f of ds.features) {
      const v = f.t[key];
      if (v === undefined) continue;
      const e = (c[v] = c[v] || { n: 0, len: 0, area: 0 });
      e.n++;
      if (f.kind === "way") { e.len += f.len || 0; e.area += f.area || 0; }
    }
    return c;
  };
  const cA = tally(dsA), cB = tally(dsB);
  const Z = { n: 0, len: 0, area: 0 };
  const values = [...new Set([...Object.keys(cA), ...Object.keys(cB)])];
  const rows = values.map((v) => {
    const a = cA[v] || Z, b = cB[v] || Z;
    return { v, a, b, _cls: (a.n === 0 || b.n === 0) ? "warn" : "" };
  });
  rows.sort((x, y) => (y.a.n + y.b.n) - (x.a.n + x.b.n));
  const fm = (v) => v ? fmtVal(v, "m") : "—";
  const fa = (v) => v ? fmtVal(v, "m2") : "—";
  const esc = (s) => String(s).replace(/'/g, "\\'");
  const cols = [
    { label: key + " = …", get: (r) => r.v, str: true,
      fmt: (v) => `<span class="clickable" title="Show ${key}=${v} on the map"` +
        ` onclick="_useFilter('${esc(key)}=${esc(v)}')">${v}</span>` },
    { label: "A count", get: (r) => r.a.n },
    { label: "A length", get: (r) => r.a.len, fmt: fm },
    { label: "A area", get: (r) => r.a.area, fmt: fa },
    { label: "B count", get: (r) => r.b.n },
    { label: "B length", get: (r) => r.b.len, fmt: fm },
    { label: "B area", get: (r) => r.b.area, fmt: fa },
  ];
  showTable(cols, rows,
    `<p class='note'><b>A</b> = ${dsA.name}, <b>B</b> = ${dsB.name}. ` +
    `Each row is a value the <b>${key}</b> tag takes. <b>Click a value</b> to highlight it ` +
    "on the maps (it fills the filter box). " +
    "Length/area are summed over ways carrying the tag — compare lengths rather than counts for " +
    "linear features (walls, fences, roads), since counts depend on how mappers split ways.</p>");
}

function topKeys(dsA, dsB) {
  const tally = (ds) => {
    const c = {};
    for (const f of ds.features)
      for (const k of Object.keys(f.t)) c[k] = (c[k] || 0) + 1;
    return c;
  };
  const cA = tally(dsA), cB = tally(dsB);
  const keys = [...new Set([...Object.keys(cA), ...Object.keys(cB)])];
  const rows = keys.map((k) => ({ k, a: cA[k] || 0, b: cB[k] || 0,
    _cls: (!cA[k] || !cB[k]) ? "warn" : "" }));
  rows.sort((x, y) => (y.a + y.b) - (x.a + x.b));
  const cols = [
    { label: "tag key", get: (r) => r.k, str: true,
      fmt: (v) => `<span class="clickable" onclick="document.getElementById('tag-key').value='${v.replace(/'/g, "\\'")}';document.getElementById('btn-explore').click()">${v}</span>` },
    { label: "A count", get: (r) => r.a },
    { label: "B count", get: (r) => r.b },
  ];
  showTable(cols, rows,
    `<p class='note'><b>A</b> = ${dsA.name}, <b>B</b> = ${dsB.name}. ` +
    "A <b>key</b> is the left side of a tag (building, shop, amenity…). " +
    "<b>Click a key</b> to see the breakdown of <b>values</b> it takes (building=house, " +
    "building=residential…), each with counts and total length/area.</p>");
}

/* -------------------------------- init -------------------------------- */

window.addEventListener("DOMContentLoaded", () => {
  for (const raw of (window.OSM_DATASETS || []))
    Datasets[raw.name] = processDataset(raw);

  const names = Object.keys(Datasets).sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    document.body.innerHTML = "<p style='padding:2em'>No datasets found. " +
      "Put .osm files in the <code>maps/</code> folder and run " +
      "<code>python prepare.py</code>.</p>";
    return;
  }

  const left = new MapView(document.getElementById("pane-left"));
  const right = new MapView(document.getElementById("pane-right"));
  PANES.push(left, right);
  refreshDatasetOptions();
  // open the first two maps alphabetically; the rest are in the dropdowns
  left.setDataset(names[0]);
  right.setDataset(names[Math.min(1, names.length - 1)]);

  document.getElementById("btn-match-scale").onclick = () => {
    right.view.scale = left.view.scale;
    right.draw();
  };
  document.getElementById("btn-compare").onclick = () => runComparison(left.ds, right.ds);
  document.getElementById("btn-areas").onclick = () => areaBreakdown(left.ds, right.ds);
  document.getElementById("btn-hist").onclick = () => buildingHistogram(left.ds, right.ds);
  document.getElementById("btn-keys").onclick = () => topKeys(left.ds, right.ds);
  document.getElementById("btn-explore").onclick = () => {
    const key = document.getElementById("tag-key").value.trim();
    if (key) exploreTag(key, left.ds, right.ds);
  };
  document.getElementById("tag-key").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-explore").click();
  });
  document.getElementById("filter-input").addEventListener("input", () => {
    activeMetricMatch = null; // typing a text filter overrides a clicked metric
    left.draw(); right.draw();
  });

  const showInBoth = () => {
    for (const p of [left, right]) {
      p.analysisKey = "highlight";
      p.anSelect.value = "highlight";
      p.draw();
    }
    document.getElementById("panel").style.display = "none";
  };

  // Clicking a value in "Explore tag" lands here: fill the filter box and
  // switch both panes to Highlight so the matches are immediately visible.
  window._useFilter = (expr) => {
    activeMetricMatch = null;
    document.getElementById("filter-input").value = expr;
    showInBoth();
  };

  // Clicking a metric name in "Compare" lands here: drive Highlight by the
  // metric's own match function (may be compound / length-based, not a
  // plain key=value), and show the label in the filter box as a reminder.
  window._useMetric = (idx) => {
    const m = COUNT_METRICS[idx];
    if (!m) return;
    activeMetricMatch = { label: m.label.trim(), match: m.match };
    document.getElementById("filter-input").value = "▶ " + m.label.trim();
    showInBoth();
  };
  document.getElementById("btn-close-panel").onclick = () => {
    document.getElementById("panel").style.display = "none";
  };
});
