#!/usr/bin/env python3
"""Disable caching during development so asset edits appear on reload.

Production hosting should cache normally.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST, PORT = "127.0.0.1", 8777


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not args or not str(args[0]).startswith(("GET", "HEAD")):
            super().log_message(fmt, *args)


# Streaming compilation requires the WebAssembly MIME type.
NoCacheHandler.extensions_map[".wasm"] = "application/wasm"


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    root = Path(__file__).resolve().parent.parent
    handler = partial(NoCacheHandler, directory=str(root))
    with ThreadingHTTPServer((HOST, port), handler) as httpd:
        print(f"  serving {root}")
        print(f"  http://{HOST}:{port}/web/index.html   (no-store: edits show on reload)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped.")


if __name__ == "__main__":
    main()
