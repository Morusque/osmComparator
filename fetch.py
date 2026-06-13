"""
Fetch a region from the OpenGeofiction Overpass API into maps/<name>.osm.

Overpass has no practical size cap (unlike the website's 50,000-element
export), so this is how you get an area bigger than the export tool allows —
and re-running it refreshes the map from the live server.

Usage
-----
    # one region, by bounding box (minlon minlat maxlon maxlat = left bottom right top)
    python fetch.py "f vigeoule" 54.23 47.46 54.58 47.63

    # ...and remember it in regions.json for next time
    python fetch.py "f vigeoule" 54.23 47.46 54.58 47.63 --save

    # refresh every region listed in regions.json
    python fetch.py

Tip for the bbox: open the area on opengeofiction.net, hit Export, and copy
the four numbers from the bounding-box boxes (they are in this same order).
Make them a bit wider than the export tool's auto-selection to get more.

Be polite: OGF's Overpass is an experimental service sharing the tile server.
Fetch the area you need, don't loop it, and avoid huge requests in tight
succession. After fetching, just reload the browser (serve.py rebuilds data/).
"""

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request

ENDPOINT = "https://overpass.opengeofiction.net/api/interpreter"
REGIONS = "regions.json"
MAPS_DIR = "maps"
UA = "ogf-map-comparator/1.0 (personal map comparison tool)"


def overpass_query(w, s, e, n, timeout):
    # everything in the bbox: nodes, ways, relations; then recurse down (>)
    # to pull every node a way/relation needs. out meta keeps version/user so
    # the result looks like a normal export.
    bbox = f"{s},{w},{n},{e}"  # Overpass order is south,west,north,east
    return (f"[out:xml][timeout:{timeout}];\n"
            f"(\n  node({bbox});\n  way({bbox});\n  relation({bbox});\n);\n"
            f"(._;>;);\nout meta;")


def fetch_region(name, w, s, e, n, timeout=180):
    print(f"Fetching '{name}'  bbox=({w},{s},{e},{n}) ...")
    query = overpass_query(w, s, e, n, timeout)
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(ENDPOINT, data=data, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout + 60) as resp:
            xml = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as ex:
        body = ex.read().decode("utf-8", "replace")[:500]
        print(f"  ERROR {ex.code} from Overpass:\n  {body}")
        return False
    except Exception as ex:
        print(f"  ERROR contacting Overpass: {ex}")
        return False

    if "<remark>" in xml:
        remark = re.search(r"<remark>(.*?)</remark>", xml, re.S)
        print(f"  Overpass returned an error: "
              f"{remark.group(1).strip() if remark else '(see output)'}")
        return False

    n_nodes = xml.count("<node ")
    if n_nodes == 0:
        print("  WARNING: 0 nodes returned — is the bbox right (and non-empty)?")

    # inject a <bounds> so the viewer reports the requested area, not just the
    # extent of the data that happened to come back
    bounds = f'  <bounds minlat="{s}" minlon="{w}" maxlat="{n}" maxlon="{e}"/>\n'
    xml = re.sub(r"(<osm\b[^>]*>\n)", r"\1" + bounds, xml, count=1)

    os.makedirs(MAPS_DIR, exist_ok=True)
    out = os.path.join(MAPS_DIR, name + ".osm")
    with open(out, "w", encoding="utf-8") as f:
        f.write(xml)
    print(f"  wrote {out}  ({os.path.getsize(out)/1e6:.1f} MB, "
          f"~{n_nodes} nodes, {xml.count('<way ')} ways, {xml.count('<relation ')} relations)")
    return True


def load_regions():
    if os.path.exists(REGIONS):
        with open(REGIONS, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_region(name, bbox):
    regions = load_regions()
    regions[name] = bbox
    with open(REGIONS, "w", encoding="utf-8") as f:
        json.dump(regions, f, indent=2, ensure_ascii=False)
    print(f"  saved '{name}' to {REGIONS}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", nargs="?", help="map name → maps/<name>.osm")
    ap.add_argument("bbox", nargs="*", type=float,
                    help="minlon minlat maxlon maxlat (left bottom right top)")
    ap.add_argument("--save", action="store_true",
                    help="remember this region in regions.json")
    ap.add_argument("--timeout", type=int, default=180)
    args = ap.parse_args()

    if not args.name:
        # refresh everything in regions.json
        regions = load_regions()
        if not regions:
            print(f"No {REGIONS} and no region given. "
                  f"Run: python fetch.py \"name\" minlon minlat maxlon maxlat")
            return
        ok = 0
        for name, (w, s, e, n) in regions.items():
            ok += fetch_region(name, w, s, e, n, args.timeout)
        print(f"Done: {ok}/{len(regions)} regions fetched. Reload the browser.")
        return

    if len(args.bbox) == 4:
        w, s, e, n = args.bbox
    else:
        # name only: look it up in regions.json
        regions = load_regions()
        if args.name not in regions:
            print(f"'{args.name}' is not in {REGIONS}; "
                  f"give a bbox: minlon minlat maxlon maxlat")
            sys.exit(1)
        w, s, e, n = regions[args.name]

    if fetch_region(args.name, w, s, e, n, args.timeout) and args.save:
        save_region(args.name, [w, s, e, n])
    print("Reload the browser — serve.py will rebuild data/ from the new map.")


if __name__ == "__main__":
    main()
