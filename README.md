# OSM map comparator

Compare two OpenStreetMap-format (`.osm`) map extracts side by side to spot
differences and anything implausible: missing or sparse amenities, odd
building sizes, thin tagging, features present in one map but not the other.
It makes no assumption about whether a map depicts a real or imagined place —
it just compares whatever `.osm` files you give it.

## Workflow

`maps/*.osm` are the source of truth. The browser actually loads compiled
`data/*.data.js` files (raw `.osm` can't be read from a folder by a web page),
so something has to convert `maps/` → `data/`. The recommended setup does that
for you automatically.

1. **Run the dev server** (Python standard library only, nothing to install):

   ```
   python serve.py
   ```

   Then open <http://localhost:8137>. The server **rebuilds `data/` from
   `maps/` automatically whenever you reload the page and a map changed**
   (edited, added, renamed, or removed) — and the rebuild is incremental, so
   only the changed map is reconverted. So the whole loop is just: **edit
   files in `maps/`, reload the browser.** Nothing else to run.

   - The first two maps alphabetically open automatically; every other map
     in `maps/` is in the dropdowns.
   - You can also **drag-and-drop a `.osm` onto either map pane** to load it
     ad-hoc for the session (parsed in the browser).

   - Or **drop one or more `.osm` files onto `drop-osm-here.bat`** (Windows):
     it copies them into `maps/` (overwriting same-named maps = an update)
     and rebuilds `data/`. Double-clicking it with nothing dropped just
     rebuilds.

   <details><summary>Manual / offline alternatives</summary>

   - `python prepare.py` — convert all of `maps/` once, by hand (same build
     the server runs). Use this if you want to open `index.html` straight
     from disk via `file://`, which works but does **not** auto-rebuild, so
     re-run `prepare.py` after changing `maps/`.
   - `python prepare.py "some other.osm" --name "Some other"` — convert a
     single file from anywhere and add it to the set.
   </details>

2. **(Optional) Pull a map straight from OpenGeofiction** — bigger than the
   website's 50,000-element export limit:

   ```
   python fetch.py "f vigeoule" 54.23 47.46 54.58 47.63 --save
   ```

   This queries OGF's Overpass API for everything in the bounding box
   (`minlon minlat maxlon maxlat` = left bottom right top — copy the numbers
   from the site's Export tab and widen them to taste) and writes
   `maps/<name>.osm`. `--save` records it in `regions.json`; then
   `python fetch.py` with no arguments **refreshes every saved region** from
   the live server. After fetching, just reload the browser.

   > Overpass on OGF is a shared, somewhat experimental service — fetch the
   > area you need, don't loop it tightly, and prefer this over scraping the
   > plain API. For the *entire* world or many extracts at once, download a
   > planet dump from <https://data.opengeofiction.net/backups>
   > (`ogf-planet.osm.pbf`, ~1.3 GB) and clip regions with `osmium extract`.

3. **Use the comparator.**

   - Left/right panes each pick a map + a visual analysis.
   - Drag = pan, wheel = zoom, double-click = fit, hover = inspect tags.
   - **Compare** runs every count metric on both displayed maps
     (normalized per km² of export bbox and per 1000 buildings).
   - **Area breakdown** sums polygon areas per category (building=*,
     landuse=*, …) with average sizes — tagging-style independent.
   - **Building sizes** overlays the two building-footprint-size
     histograms (share per log bin, directly comparable shapes).
   - All result tables are sortable — click a column header (e.g. ratio).
   - **Tags are `key=value` pairs** (`building=residential`,
     `shop=bakery`). The iD editor's friendly preset names ("Bâtiment
     résidentiel") are just bookmarks for these raw tags — to see what a
     preset actually wrote, **hover over the feature here** and read the
     tooltip. Two header fields work with tags:
     - **explore key** → takes a *key only* (`building`) and lists every
       *value* it takes in both maps, with counts + total length/area.
       (**Top tag keys** first if you don't know the keys; click one.)
       **Click a value** in the result to send it to the filter and
       highlight it on the maps.
     - **filter** → a key (`shop` = any shop) or `key=value`
       (`building=residential`) or `value1|value2`. Drives the
       *Highlight filter matches* and *Density grid* visual modes.
   - **Click a metric name in Compare** (Restaurants, Cafés, …) to
     highlight those features on both maps — handy for metrics that aren't
     a simple `key=value` (it uses the metric's own match rule). Switch a
     pane to *Density grid* to see them as a heatmap instead. Typing in
     the filter box again takes back over.
   - **Match right scale to left** for true-scale visual comparison.

   > **Tagging-style gotcha.** Different mappers describe the same thing
   > with different tags. One map may carry thousands of `building=yes`
   > while another's editor presets produce `building=residential`,
   > `building=house`, etc. So a value can read as "only in A / only in B"
   > purely from tagging convention, not a genuine difference. When that
   > happens, fall back to the whole key (any value), to areas, or to
   > building-size histograms, which don't care how the value is spelled.
   > The Compare ratio is bipolar — an imbalance in *either* direction is
   > flagged (yellow ≥2×, red ≥4× or present in only one map).

3. **Add your own analyses in [`analyses.js`](analyses.js)** — that's the
   whole point of the template. Two extension points:

   - `ANALYSES.my_thing = { label, style(f) }` — a visual layer. `style(f)`
     receives each feature (`f.t` tags, `f.len` m, `f.area` m², `f.closed`,
     `f.kind`) and returns `{fill, stroke, width, r, z}` or `null`.
     Helpers: `heat(v, min, max)`, `catColor(str)`.
   - `M("label", matchFn, valueFn?, unit?)` — a row in the Compare table.

   Reload the page; no build step (scripts load cache-busted).

## Files

| path | role |
|---|---|
| `maps/` | **drop your `.osm` files here** — the source of truth |
| `drop-osm-here.bat` | Windows: drag `.osm` files onto it to copy into `maps/` + rebuild |
| `fetch.py` | pull a region from OGF's Overpass API into `maps/` (beats the export cap) |
| `regions.json` | saved name→bbox regions for `python fetch.py` to refresh |
| `serve.py` | dev server; auto-rebuilds `data/` from `maps/` on reload |
| `prepare.py` | the build step itself: `maps/*.osm` → compact `data/*.data.js` (projects to local meters, precomputes length/area) |
| `data/` | compiled cache the browser loads; regenerated from `maps/`, safe to delete |
| `analyses.js` | **edit me** — visual layers + count metrics |
| `viewer.js` | rendering engine, comparison/tag tables |
| `index.html` | UI shell |

## Notes & caveats

- Coordinates are projected to meters around each map's center, so scales
  are directly comparable between maps.
- Multipolygon relations are not assembled into geometry (their member ways
  are drawn individually; relation tags are still counted in metrics).
- Export bounding boxes can differ wildly in size, so per-km² densities are
  rough; the Compare table's ratio column normalizes per 1000 buildings.
- Length/area metrics still depend on how much area an export covers — for
  fair totals, compare extracts of comparable size.
