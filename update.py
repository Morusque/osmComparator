"""
update.py — refresh EVERY map in maps/ from its live source server, then
rebuild data/. Run it with update-all.bat, or `python update.py`.
Add --dry-run to see the routing without fetching anything.

Each map is routed to a server by its filename prefix:
    "f ..."  ->  OpenGeofiction (fictional)   overpass.opengeofiction.net
    "r ..."  ->  OpenStreetMap   (real)       overpass-api.de
(Rename a file to change which server it updates from.)

The area fetched is the map's *current* <bounds> — a true refresh at the same
extent. Use extend.py to make a map cover more ground. A polite delay is left
between calls because these Overpass servers are small and shared.
"""

import glob
import os
import sys
import time

import fetch
import prepare

DELAY_SECONDS = 5  # pause between server calls; raise if you have many maps


def main():
    dry = "--dry-run" in sys.argv
    maps = sorted(glob.glob(os.path.join(fetch.MAPS_DIR, "*.osm")))
    if not maps:
        print(f"No .osm files in {fetch.MAPS_DIR}/.")
        return

    print(f"Updating {len(maps)} map(s) from their source servers.")
    print("Source is chosen by filename prefix:")
    print("  'f ...'  ->  OpenGeofiction (fictional)")
    print("  'r ...'  ->  OpenStreetMap   (real)")
    print("  (rename a file to change its source.)\n")

    todo, skipped = [], []
    for path in maps:
        name = os.path.splitext(os.path.basename(path))[0]
        r = fetch.route(name)
        if r is None:
            skipped.append((name, "no 'f '/'r ' prefix - unknown source server"))
            continue
        bounds = fetch.read_bounds(path)
        if bounds is None:
            skipped.append((name, "no <bounds> in the file - unknown area to fetch"))
            continue
        todo.append((name, bounds, r[0], r[1]))

    for name, _b, label, _e in todo:
        print(f"  will update  {name!r:28}  from  {label}")
    for name, why in skipped:
        print(f"  SKIP         {name!r:28}  ({why})")
    print()

    if dry:
        print("(--dry-run: nothing fetched)")
        return
    if not todo:
        return

    ok = 0
    for i, (name, (w, s, e, n), label, endpoint) in enumerate(todo):
        print(f"[{i + 1}/{len(todo)}] {name!r} <- {label}")
        if fetch.fetch_region(name, w, s, e, n, endpoint=endpoint):
            ok += 1
        if i < len(todo) - 1:
            print(f"      waiting {DELAY_SECONDS}s before the next call "
                  f"(shared servers, being polite) ...")
            time.sleep(DELAY_SECONDS)

    print(f"\nFetched {ok}/{len(todo)} map(s). Rebuilding data/ ...\n")
    prepare.build_folder()
    print("\nDone. Reload the browser to see the updated maps.")


if __name__ == "__main__":
    main()
