"""Astro Analytics dev server.

Sets COOP + COEP headers so DuckDB-WASM can use SharedArrayBuffer.
Uses 'credentialless' COEP (safer than 'require-corp') — works with CDN
resources (Google Fonts, jsDelivr) without needing CORP headers from them.
Also disables all caching so you always get the latest JS/CSS on reload.

Run from the project folder:
    python serve.py
Then open:  http://localhost:8080
"""
import http.server
import socketserver
import os

PORT = 8080

class AstroHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Required for SharedArrayBuffer (DuckDB-WASM multi-thread mode)
        self.send_header("Cross-Origin-Opener-Policy",   "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        # No caching — always serve the latest files
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma",  "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Print everything so you can see what's loading
        super().log_message(fmt, *args)

os.chdir(os.path.dirname(os.path.abspath(__file__)))
print(f"==============================================")
print(f"  Astro Analytics dev server")
print(f"  http://localhost:{PORT}")
print(f"  COOP + COEP headers active (SharedArrayBuffer enabled)")
print(f"  No-cache mode (always fresh JS/CSS)")
print(f"==============================================")
print(f"Press Ctrl+C to stop.\n")

with socketserver.TCPServer(("", PORT), AstroHandler) as httpd:
    httpd.allow_reuse_address = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
