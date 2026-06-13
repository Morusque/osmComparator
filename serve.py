"""
Dev server for the map comparator.

    python serve.py            # serves on http://localhost:8137
    python serve.py 9000       # ... on a different port

Unlike `python -m http.server`, this rebuilds data/ from maps/ automatically
whenever you reload the page and a map has changed (edited, added, renamed or
removed). So the normal loop is just: edit files in maps/, reload the browser.

(You can still run `python prepare.py` by hand, and you can still open
index.html straight from disk via file:// — but then nothing auto-rebuilds,
so re-run prepare.py after changing maps/.)
"""

import http.server
import os
import socketserver
import sys

import prepare

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        # Before serving the page, bring data/ up to date with maps/.
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            try:
                if prepare.needs_rebuild():
                    print("maps/ changed — rebuilding data/ ...")
                    prepare.build_folder()
            except Exception as e:  # never let a build error take the server down
                print("rebuild failed:", e)
        return super().do_GET()

    def end_headers(self):
        # data/ and the .js are rebuilt in place; tell the browser not to cache
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    # one build up front so the first load is correct even from a cold start
    try:
        if prepare.needs_rebuild():
            print("Building data/ from maps/ ...")
            prepare.build_folder()
    except Exception as e:
        print("initial build failed:", e)
    with Server(("", PORT), Handler) as httpd:
        print(f"Serving http://localhost:{PORT}  "
              f"(auto-rebuilds data/ from maps/ on reload)")
        httpd.serve_forever()
