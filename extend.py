"""
extend.py — one-shot: enlarge the area of a SINGLE map and re-fetch it from
its source server. Because the bigger box is a superset of the old one, the
refreshed file just covers more ground (nothing to merge).

    # grow the map's current bounds by 0.05 degrees on every side
    python extend.py "f vigeoule" --margin 0.05

    # or give an explicit new bounding box: minlon minlat maxlon maxlat
    python extend.py "f vigeoule" --bbox 54.10 47.30 54.70 47.80

Source is routed by the same "f "/"r " filename prefix as update.py:
"f " -> OpenGeofiction, "r " -> OpenStreetMap.
"""

import argparse
import os
import sys

import fetch
import prepare


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", help="map name (the file in maps/, without .osm)")
    ap.add_argument("--margin", type=float,
                    help="degrees to add on each side of the current bounds")
    ap.add_argument("--bbox", nargs=4, type=float,
                    metavar=("MINLON", "MINLAT", "MAXLON", "MAXLAT"),
                    help="explicit new bounding box (left bottom right top)")
    args = ap.parse_args()

    r = fetch.route(args.name)
    if r is None:
        print(f"Don't know the source for {args.name!r} - it needs an "
              f"'f '/'r ' prefix.")
        sys.exit(1)
    label, endpoint = r

    path = os.path.join(fetch.MAPS_DIR, args.name + ".osm")
    if args.bbox:
        w, s, e, n = args.bbox
    elif args.margin is not None:
        cur = fetch.read_bounds(path) if os.path.exists(path) else None
        if cur is None:
            print(f"Can't read current bounds of {path}; pass --bbox instead.")
            sys.exit(1)
        m = args.margin
        w, s, e, n = cur[0] - m, cur[1] - m, cur[2] + m, cur[3] + m
        print(f"Current bounds {cur} + {m}deg margin -> ({w},{s},{e},{n})")
    else:
        print("Give --margin DEG, or --bbox MINLON MINLAT MAXLON MAXLAT.")
        sys.exit(1)

    print(f"Extending {args.name!r} from {label} ...")
    if fetch.fetch_region(args.name, w, s, e, n, endpoint=endpoint):
        print("Rebuilding data/ ...\n")
        prepare.build_folder()
        print("\nDone. Reload the browser.")


if __name__ == "__main__":
    main()
