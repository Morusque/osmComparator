"""
update.py — refresh maps in maps/ from their live source servers, then
rebuild data/. Run it with update-all.bat, or `python update.py`.

By default every map is refreshed. Name one or more to refresh just those:

    python update.py "f vigeoule"

which is what update-vigeoule.bat does — the map you are actually editing
moves far faster than the rest, and pulling the whole set to see one town is
a lot of traffic for a small shared server.

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
    wanted = [a for a in sys.argv[1:] if not a.startswith("--")]
    maps = sorted(glob.glob(os.path.join(fetch.MAPS_DIR, "*.osm")))
    if not maps:
        print(f"No .osm files in {fetch.MAPS_DIR}/.")
        return

    if wanted:
        # Named maps only. Handy when one region moves far faster than the
        # rest and you do not want to pull the whole set to see it.
        chosen = [p for p in maps
                  if os.path.splitext(os.path.basename(p))[0] in wanted]
        missing = set(wanted) - {os.path.splitext(os.path.basename(p))[0]
                                 for p in chosen}
        for name in sorted(missing):
            print(f"  no map called {name!r} in {fetch.MAPS_DIR}/")
        if not chosen:
            print("Nothing to update.")
            return
        maps = chosen

    print(f"Updating {len(maps)} map(s) from their source servers"
          + (f" (only: {', '.join(wanted)})" if wanted else "") + ".")
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
