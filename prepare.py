"""
Convert OSM XML files (.osm) into compact .data.js files for the viewer.

Typical use — drop your .osm files into the maps/ folder and run:

    python prepare.py

That converts every maps/*.osm into data/<slug>.data.js and regenerates
data/manifest.js (the list the viewer loads). The viewer opens the first two
maps alphabetically and offers the rest in the dropdowns.

You can also convert a single file from anywhere:

    python prepare.py "some other.osm" --name "Some other"

Coordinates are projected to local meters (equirectangular, centered on the
map) so the viewer works at true scale and can compare maps directly.
Per-way length (m) and area (m2, for closed ways) are precomputed.
"""

import argparse
import glob
import math
import json
import os
import re
import xml.etree.ElementTree as ET

M_PER_DEG_LAT = 111320.0
MAPS_DIR = "maps"
OUT_DIR = "data"


def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "dataset"


def parse_osm(path):
    nodes = {}          # id -> (lat, lon)
    points = []         # tagged nodes: (lat, lon, tags)
    ways = []           # {id, refs, tags}
    relations = []      # {id, tags, way_refs}
    bounds = None

    for event, elem in ET.iterparse(path, events=("end",)):
        tag = elem.tag
        if tag == "bounds":
            bounds = (float(elem.get("minlat")), float(elem.get("minlon")),
                      float(elem.get("maxlat")), float(elem.get("maxlon")))
        elif tag == "node":
            nid = int(elem.get("id"))
            lat, lon = float(elem.get("lat")), float(elem.get("lon"))
            nodes[nid] = (lat, lon)
            tags = {t.get("k"): t.get("v") for t in elem.findall("tag")}
            if tags:
                points.append((lat, lon, tags))
            elem.clear()
        elif tag == "way":
            refs = [int(n.get("ref")) for n in elem.findall("nd")]
            tags = {t.get("k"): t.get("v") for t in elem.findall("tag")}
            ways.append({"id": int(elem.get("id")), "refs": refs, "tags": tags})
            elem.clear()
        elif tag == "relation":
            tags = {t.get("k"): t.get("v") for t in elem.findall("tag")}
            way_refs = [int(m.get("ref")) for m in elem.findall("member")
                        if m.get("type") == "way"]
            if tags:
                relations.append({"id": int(elem.get("id")),
                                  "tags": tags, "way_refs": way_refs})
            elem.clear()

    return nodes, points, ways, relations, bounds


def convert(osm_file, name, outdir):
    slug = slugify(name)
    print(f"Parsing {osm_file} ...")
    nodes, points, ways, relations, bounds = parse_osm(osm_file)
    print(f"  {len(nodes)} nodes ({len(points)} tagged), "
          f"{len(ways)} ways, {len(relations)} tagged relations")

    # Projection center: middle of the bounds, or of the node cloud.
    if bounds:
        lat0 = (bounds[0] + bounds[2]) / 2
        lon0 = (bounds[1] + bounds[3]) / 2
    else:
        lat0 = sum(ll[0] for ll in nodes.values()) / len(nodes)
        lon0 = sum(ll[1] for ll in nodes.values()) / len(nodes)
    m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(lat0))

    def project(lat, lon):
        return ((lon - lon0) * m_per_deg_lon, (lat - lat0) * M_PER_DEG_LAT)

    # Keep ways that are tagged, or untagged but used by a tagged relation
    # (e.g. multipolygon members) so future analyses can reach them.
    rel_way_ids = set()
    for r in relations:
        rel_way_ids.update(r["way_refs"])

    out_ways = []
    missing_nodes = 0
    for w in ways:
        if not w["tags"] and w["id"] not in rel_way_ids:
            continue
        xy = []
        for ref in w["refs"]:
            ll = nodes.get(ref)
            if ll is None:
                missing_nodes += 1
                continue
            x, y = project(*ll)
            xy.extend((round(x, 1), round(y, 1)))
        if len(xy) < 4:
            continue
        closed = w["refs"][0] == w["refs"][-1] and len(w["refs"]) >= 4
        # length (m) and shoelace area (m2) on the projected coords
        length = 0.0
        area2 = 0.0
        n = len(xy) // 2
        for i in range(n - 1):
            x1, y1, x2, y2 = xy[2*i], xy[2*i+1], xy[2*i+2], xy[2*i+3]
            length += math.hypot(x2 - x1, y2 - y1)
            area2 += x1 * y2 - x2 * y1
        entry = {"id": w["id"], "xy": xy, "t": w["tags"],
                 "len": round(length, 1)}
        if closed:
            entry["closed"] = 1
            entry["area"] = round(abs(area2) / 2, 1)
        out_ways.append(entry)
    if missing_nodes:
        print(f"  warning: {missing_nodes} way node refs missing from file "
              f"(truncated export edges, harmless)")

    out_points = []
    for lat, lon, tags in points:
        x, y = project(lat, lon)
        out_points.append({"x": round(x, 1), "y": round(y, 1), "t": tags})

    out_rels = [{"id": r["id"], "t": r["tags"], "ways": r["way_refs"]}
                for r in relations]

    bounds_m = None
    if bounds:
        x1, y1 = project(bounds[0], bounds[1])
        x2, y2 = project(bounds[2], bounds[3])
        bounds_m = [round(min(x1, x2), 1), round(min(y1, y2), 1),
                    round(max(x1, x2), 1), round(max(y1, y2), 1)]

    dataset = {
        "name": name,
        "slug": slug,
        "source": os.path.basename(osm_file),
        "center": [round(lat0, 6), round(lon0, 6)],
        "bounds_m": bounds_m,
        "points": out_points,
        "ways": out_ways,
        "relations": out_rels,
    }

    os.makedirs(outdir, exist_ok=True)
    out_path = os.path.join(outdir, slug + ".data.js")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("window.OSM_DATASETS=window.OSM_DATASETS||[];\n")
        f.write("window.OSM_DATASETS.push(")
        json.dump(dataset, f, ensure_ascii=False, separators=(",", ":"))
        f.write(");\n")
    size_mb = os.path.getsize(out_path) / 1e6
    print(f"  wrote {out_path} ({size_mb:.1f} MB): "
          f"{len(out_ways)} ways, {len(out_points)} points, {len(out_rels)} relations")
    return os.path.basename(out_path)


def write_manifest(files, outdir):
    files = sorted(files)
    manifest = os.path.join(outdir, "manifest.js")
    with open(manifest, "w", encoding="utf-8") as f:
        f.write("window.OSM_DATA_FILES=" + json.dumps(files) + ";\n")
    print(f"manifest: {files}")


def build_folder(maps_dir=MAPS_DIR, outdir=OUT_DIR):
    """Make data/ mirror maps/. Incremental: only (re)convert maps whose
    .osm is new or newer than its .data.js; drop data for removed/renamed
    maps. data/ is treated as a disposable cache of maps/."""
    osm_files = sorted(glob.glob(os.path.join(maps_dir, "*.osm")))
    os.makedirs(outdir, exist_ok=True)

    expected = {}  # data filename -> (osm path, display name)
    for path in osm_files:
        name = os.path.splitext(os.path.basename(path))[0]
        expected[slugify(name) + ".data.js"] = (path, name)

    # drop data files whose source map was removed or renamed
    for f in os.listdir(outdir):
        if f.endswith(".data.js") and f not in expected:
            os.remove(os.path.join(outdir, f))

    for data_name, (path, name) in expected.items():
        out_path = os.path.join(outdir, data_name)
        if not os.path.exists(out_path) or os.path.getmtime(path) > os.path.getmtime(out_path):
            convert(path, name, outdir)
        else:
            print(f"up to date: {data_name}")

    if not osm_files:
        print(f"No .osm files found in {maps_dir}/. "
              f"Put your maps there, or pass a file path explicitly.")
    write_manifest(list(expected.keys()), outdir)
    return list(expected.keys())


def needs_rebuild(maps_dir=MAPS_DIR, outdir=OUT_DIR):
    """True if maps/ changed since the last build: a file edited, added,
    removed or renamed (or nothing built yet)."""
    osm_files = glob.glob(os.path.join(maps_dir, "*.osm"))
    manifest = os.path.join(outdir, "manifest.js")
    if not os.path.exists(manifest):
        return True
    built_at = os.path.getmtime(manifest)
    if max((os.path.getmtime(f) for f in osm_files), default=0) > built_at:
        return True  # a source was edited
    # add / remove / rename: compare the expected data files to what exists
    expected = {slugify(os.path.splitext(os.path.basename(f))[0]) + ".data.js"
                for f in osm_files}
    actual = {f for f in os.listdir(outdir) if f.endswith(".data.js")}
    return expected != actual


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("osm_file", nargs="?",
                    help="a single .osm to convert; omit to convert every .osm in maps/")
    ap.add_argument("--name", help="display name (default: derived from filename)")
    ap.add_argument("--outdir", default=OUT_DIR)
    args = ap.parse_args()

    if args.osm_file:
        # Single-file mode: convert one file, then rebuild the manifest from
        # whatever .data.js files exist (so it joins the existing set).
        name = args.name or os.path.splitext(os.path.basename(args.osm_file))[0]
        convert(args.osm_file, name, args.outdir)
        files = [f for f in os.listdir(args.outdir) if f.endswith(".data.js")]
        write_manifest(files, args.outdir)
        return

    build_folder(MAPS_DIR, args.outdir)


if __name__ == "__main__":
    main()
