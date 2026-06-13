/*
 * analyses.js — THE FILE YOU EDIT.
 *
 * Two kinds of things live here:
 *
 * 1. ANALYSES — visual layers. Each one is a style(f) function that decides
 *    how a feature is drawn. Pick one from the dropdown above each map.
 *
 *    A feature f looks like:
 *      f.kind   "way" | "point"
 *      f.t      tag object, e.g. {building:"house", "addr:housenumber":"12"}
 *      f.len    length in meters (ways only)
 *      f.area   area in m² (closed ways only, else undefined)
 *      f.closed true for closed ways (polygons)
 *
 *    style(f) returns null to hide the feature, or:
 *      { fill: cssColor,      // fill (closed ways / point dots)
 *        stroke: cssColor,    // outline / line color
 *        width: px,           // line width in screen pixels
 *        r: px,               // point radius in screen pixels
 *        z: 0..9 }            // draw order (0 = bottom)
 *
 *    Helpers available:
 *      heat(value, min, max)  -> blue→yellow→red color ramp
 *      catColor(string)       -> stable categorical color for a string
 *      currentFilter()        -> parsed value of the header filter box
 *      matchesFilter(f, flt)  -> does feature f match it?
 *
 *    An analysis may also define overlay(view), called after the features
 *    are drawn — see ANALYSES.density for a worked example (custom canvas
 *    drawing with view.ctx, view.w2s(x,y), view.s2w(px,py), view.ds).
 *
 * 2. COUNT_METRICS — the comparison table ("Compare" button). Each metric
 *    is counted/summed over every feature (points, ways AND relations) of
 *    both displayed maps, and shown side by side, normalized per km² of
 *    export bounds and per 1000 buildings.
 */

"use strict";

const ANALYSES = {};
const COUNT_METRICS = [];

/* ============================== VISUAL LAYERS ========================== */

// --- Default map render -------------------------------------------------
ANALYSES.map = {
  label: "Map (default render)",
  style(f) {
    const t = f.t;
    if (f.kind === "point") {
      if (t.shop) return { fill: "#e879f9", r: 2.5, z: 8 };
      if (t.amenity) return { fill: "#fbbf24", r: 2.5, z: 8 };
      if (t.natural === "tree") return { fill: "#3f7d44", r: 1.3, z: 7 };
      if (t.highway === "street_lamp") return { fill: "#705", r: 1.2, z: 7 };
      return null;
    }
    // polygons / lines
    if (t.building) return { fill: "#8d8478", stroke: "#6b6358", width: 0.5, z: 4 };
    if (t.highway) {
      const w = { motorway: 6, trunk: 6, primary: 5, secondary: 4.5, tertiary: 4,
                  residential: 3, unclassified: 3, living_street: 3, service: 1.8,
                  pedestrian: 2.5, track: 1.2, footway: 1, path: 1, cycleway: 1, steps: 1.5 };
      const c = { motorway: "#e892a2", trunk: "#f9b29c", primary: "#fcd6a4",
                  secondary: "#f7fabf", footway: "#b07c6b", path: "#b07c6b",
                  cycleway: "#7c9ed9", steps: "#c66", track: "#9a7" };
      if (t.area === "yes" && f.closed) return { fill: "#777e88", z: 3 };
      return { stroke: c[t.highway] || "#cfd3da", width: w[t.highway] || 2, z: 5 };
    }
    if (t.railway && t.railway !== "abandoned") return { stroke: "#999", width: 1.5, z: 5 };
    if (t.natural === "water" || t.water || t.landuse === "reservoir" || t.landuse === "basin")
      return { fill: "#39597e", z: 2 };
    if (t.waterway) {
      const w = { river: 4, canal: 3, stream: 1.2, ditch: 0.8, drain: 0.8 };
      return { stroke: "#39597e", width: w[t.waterway] || 1.5, z: 2 };
    }
    if (t.natural === "wood" || t.landuse === "forest") return { fill: "#2c4630", z: 1 };
    if (t.leisure === "park" || t.leisure === "garden" || t.landuse === "grass" ||
        t.landuse === "meadow" || t.landuse === "village_green" || t.natural === "grassland" ||
        t.landuse === "recreation_ground" || t.natural === "scrub")
      return { fill: "#37503a", z: 1 };
    if (t.leisure === "pitch" || t.leisure === "playground" || t.leisure === "sports_centre")
      return { fill: "#3d6051", z: 2 };
    if (t.landuse === "farmland" || t.landuse === "orchard" || t.landuse === "vineyard" ||
        t.landuse === "farmyard") return { fill: "#3a3d2e", z: 1 };
    if (t.landuse === "residential") return { fill: "#26262e", z: 0 };
    if (t.landuse === "industrial" || t.landuse === "commercial" || t.landuse === "retail")
      return { fill: "#322a33", z: 0 };
    if (t.landuse === "cemetery" || t.amenity === "grave_yard") return { fill: "#324239", z: 1 };
    if (t.amenity === "parking" && f.closed) return { fill: "#3a3f49", z: 2 };
    if (t.aeroway) return f.closed ? { fill: "#444a55", z: 2 } : { stroke: "#555c68", width: 4, z: 3 };
    if (t.barrier) return { stroke: "#55504a", width: 0.7, z: 3 };
    if (t.power === "line") return { stroke: "#665", width: 0.7, z: 6 };
    // anything tagged but unstyled: faint outline so it's at least visible
    if (Object.keys(t).length)
      return f.closed ? { stroke: "#3a3a44", width: 0.7, z: 1 } : { stroke: "#33333c", width: 0.7, z: 1 };
    return null; // untagged geometry (relation members)
  },
};

// --- Building footprint area -------------------------------------------
// As a rough guide, detached houses are ~60–200 m², apartment blocks
// 200–1500 m². Watch for buildings systematically too big or too small.
ANALYSES.building_area = {
  label: "Building area (m²)",
  legend: { min: 50, max: 1000, unit: "m²", log: true },
  style(f) {
    if (f.kind !== "way" || !f.t.building) return dimContext(f);
    if (!f.closed) return null;
    return { fill: heat(Math.log10(f.area || 1), Math.log10(50), Math.log10(1000)), z: 4 };
  },
};

// --- Building type ------------------------------------------------------
// Are buildings actually typed (house/apartments/garage/church...) or all
// just building=yes? Compare the color diversity of the two maps.
ANALYSES.building_type = {
  label: "Building type (categorical)",
  style(f) {
    if (f.kind !== "way" || !f.t.building) return dimContext(f);
    if (f.t.building === "yes") return { fill: "#555", z: 4 }; // untyped = grey
    return { fill: catColor(f.t.building), z: 4 };
  },
};

// --- Address coverage ---------------------------------------------------
// In a thoroughly mapped area most buildings carry addr:housenumber.
ANALYSES.addresses = {
  label: "Buildings: has address?",
  style(f) {
    if (f.kind === "point" && f.t["addr:housenumber"]) return { fill: "#4ade80", r: 2, z: 8 };
    if (f.kind !== "way" || !f.t.building) return dimContext(f);
    return { fill: f.t["addr:housenumber"] ? "#4ade80" : "#7f1d1d", z: 4 };
  },
};

// --- Road classes -------------------------------------------------------
// Does the road hierarchy look plausible? (ratio of residential to primary,
// presence of service roads, footways...)
ANALYSES.road_class = {
  label: "Road class (categorical)",
  style(f) {
    if (f.kind !== "way" || !f.t.highway) return dimContext(f);
    return { stroke: catColor(f.t.highway), width: 2.5, z: 5 };
  },
};

// --- Tag richness -------------------------------------------------------
// How many tags does each feature carry? Sparse tagging shows up dark.
ANALYSES.tag_richness = {
  label: "Tag count per feature",
  legend: { min: 1, max: 8, unit: "tags" },
  style(f) {
    const n = Object.keys(f.t).length;
    if (!n) return null;
    if (f.kind === "point") return { fill: heat(n, 1, 8), r: 2.5, z: 8 };
    return f.closed ? { fill: heat(n, 1, 8), z: 4 } : { stroke: heat(n, 1, 8), width: 2, z: 5 };
  },
};

// --- Zone areas ---------------------------------------------------------
// Every closed polygon (buildings, landuse, leisure, natural...) colored by
// its area, log scale. Use with the "Area breakdown" button for totals.
ANALYSES.zone_area = {
  label: "Zone area (all polygons, m²)",
  legend: { min: 100, max: 100000, unit: "m²", log: true },
  style(f) {
    if (f.kind !== "way" || !f.closed || !f.area || !Object.keys(f.t).length)
      return dimContext(f);
    return { fill: heat(Math.log10(f.area), 2, 5), z: f.t.building ? 4 : 2 };
  },
};

// --- Filter highlight ----------------------------------------------------
// Type a filter in the header box ("shop", "amenity=restaurant|cafe",
// "barrier=wall"...) — matches glow, everything else is faint context.
ANALYSES.highlight = {
  label: "Highlight filter matches",
  style(f) {
    const m = currentMatcher();
    if (!m || !m.test(f)) return dimContext(f);
    if (f.kind === "point") return { fill: "#fbbf24", r: 4, z: 9 };
    return f.closed ? { fill: "#fbbf24", z: 8 } : { stroke: "#fbbf24", width: 3, z: 8 };
  },
};

// --- Density grid --------------------------------------------------------
// How many filter matches per cell? The cell size adapts to the zoom level
// (shown in the corner), so zoom in to refine. Uses way centroids.
ANALYSES.density = {
  label: "Density grid (of filter matches)",
  style(f) { return f.kind === "point" ? null : dimContext(f); },
  overlay(view) {
    const ctx = view.ctx, dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const m = currentMatcher();
    if (!m) {
      ctx.fillStyle = "#fbbf24"; ctx.font = "13px sans-serif";
      ctx.fillText("Type a filter (e.g. amenity=restaurant) or click a row in Compare to see its density", 14, 44);
      return;
    }
    // cell size: ~56 px at current zoom, snapped to a round number of meters
    const target = 56 / view.view.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const cell = target / pow >= 5 ? 5 * pow : target / pow >= 2 ? 2 * pow : pow;
    const counts = new Map();
    let max = 0, total = 0;
    for (const f of view.ds.features) {
      if (f.kind === "relation" || !m.test(f)) continue;
      const x = f.kind === "point" ? f.x : f.cx;
      const y = f.kind === "point" ? f.y : f.cy;
      const k = Math.floor(x / cell) + "_" + Math.floor(y / cell);
      const n = (counts.get(k) || 0) + 1;
      counts.set(k, n);
      if (n > max) max = n;
      total++;
    }
    ctx.globalAlpha = 0.55;
    for (const [k, n] of counts) {
      const [ix, iy] = k.split("_").map(Number);
      const [px, py] = view.w2s(ix * cell, (iy + 1) * cell);
      const [px2, py2] = view.w2s((ix + 1) * cell, iy * cell);
      ctx.fillStyle = heat(n, 0, max);
      ctx.fillRect(px, py, px2 - px, py2 - py);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(20,22,28,.8)";
    ctx.fillRect(8, 8, 280, 22);
    ctx.fillStyle = "#ddd"; ctx.font = "11px sans-serif";
    const cellTxt = cell >= 1000 ? (cell / 1000) + " km" : cell + " m";
    ctx.fillText(`${m.label}: ${total} matches, cell ${cellTxt}, max ${max}/cell`, 14, 23);
  },
};

// Helper used above: keep non-matching features as a faint context layer.
function dimContext(f) {
  const t = f.t;
  if (f.kind === "point") return null;
  if (t.highway) return { stroke: "#383840", width: 1, z: 2 };
  if (t.building) return { fill: "#26262c", z: 1 };
  if (t.natural === "water" || t.water || t.waterway) return { stroke: "#2a3a50", fill: f.closed ? "#22304a" : undefined, width: 1, z: 0 };
  return null;
}

/* ============================ COUNT METRICS ============================ */
/*
 * Each metric: { label, match(f), value(f)?, unit? }
 *   match(f)  -> include this feature?
 *   value(f)  -> what to sum (default 1 = count). e.g. f.len, f.area
 *   unit      -> "count" (default) | "m" | "m2"
 * Relations are passed too (f.kind === "relation", only f.t is set), so
 * guard with f.kind if you use len/area.
 */

const M = (label, match, value, unit) => COUNT_METRICS.push({ label, match, value, unit });
const tagEq = (k, v) => (f) => f.t[k] === v;
const tagAny = (k) => (f) => f.t[k] !== undefined;

// — Everyday amenities a populated area tends to have —
M("Restaurants", tagEq("amenity", "restaurant"));
M("Cafés", tagEq("amenity", "cafe"));
M("Bars / pubs", (f) => f.t.amenity === "bar" || f.t.amenity === "pub");
M("Fast food", tagEq("amenity", "fast_food"));
M("Shops (any shop=*)", tagAny("shop"));
M("  bakeries", tagEq("shop", "bakery"));
M("  hairdressers", tagEq("shop", "hairdresser"));
M("  supermarkets", tagEq("shop", "supermarket"));
M("  clothes shops", tagEq("shop", "clothes"));
M("Pharmacies", tagEq("amenity", "pharmacy"));
M("Doctors / clinics", (f) => f.t.amenity === "doctors" || f.t.amenity === "clinic" || f.t.healthcare !== undefined);
M("Banks", tagEq("amenity", "bank"));
M("Schools", (f) => f.t.amenity === "school" || f.t.amenity === "kindergarten");
// catches both tagging styles: amenity=place_of_worship AND building=church/…
// (some maps tag only the building, which would otherwise read as "missing")
M("Places of worship", (f) => f.t.amenity === "place_of_worship" ||
  ["church", "chapel", "cathedral", "mosque", "temple", "synagogue", "shrine"].includes(f.t.building));
M("Fuel stations", tagEq("amenity", "fuel"));
M("Parking (areas+points)", tagEq("amenity", "parking"));

// — Street furniture / micro-mapping (often sparse in less-detailed maps) —
M("Benches", tagEq("amenity", "bench"));
M("Waste baskets", tagEq("amenity", "waste_basket"));
M("Street lamps", tagEq("highway", "street_lamp"));
M("Individual trees", tagEq("natural", "tree"));
M("Pedestrian crossings", tagEq("highway", "crossing"));
M("Bus stops", tagEq("highway", "bus_stop"));
M("Drinking water", tagEq("amenity", "drinking_water"));

// — Structure —
M("Buildings", tagAny("building"));
M("  with address", (f) => f.t.building && f.t["addr:housenumber"]);
M("  typed (not building=yes)", (f) => f.t.building && f.t.building !== "yes");
M("Building footprint total", tagAny("building"), (f) => f.area || 0, "m2");
M("Road length (all highway=*)", (f) => f.kind === "way" && f.t.highway, (f) => f.len, "m");
M("  residential streets", (f) => f.kind === "way" && f.t.highway === "residential", (f) => f.len, "m");
M("  service roads", (f) => f.kind === "way" && f.t.highway === "service", (f) => f.len, "m");
M("  footways/paths", (f) => f.kind === "way" && (f.t.highway === "footway" || f.t.highway === "path"), (f) => f.len, "m");
M("Named features", tagAny("name"));
M("Waterway length", (f) => f.kind === "way" && f.t.waterway, (f) => f.len, "m");

// — Linear barriers: compare LENGTH, not counts. A single long wall and the
//   same wall split into 20 segments give the same length but wildly
//   different counts — counts are a tagging-style artifact. —
M("Walls length (incl. city/retaining)", (f) => f.kind === "way" &&
  ["wall", "city_wall", "retaining_wall"].includes(f.t.barrier), (f) => f.len, "m");
M("Fences length", (f) => f.kind === "way" && f.t.barrier === "fence", (f) => f.len, "m");
M("Hedges length", (f) => f.kind === "way" && f.t.barrier === "hedge", (f) => f.len, "m");
