"""Local static server for "Mapa iterativo" that disables browser caching (dev preview only)."""
import functools
import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'Mapa iterativo')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5500


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(NoCache, directory=ROOT)).serve_forever()
