"""Check the smoke client's session behavior over real HTTP."""

import http.server
import json
import threading
import unittest
import urllib.error

from encryption_smoke import make_request, portable_export


class SmokeSessionTests(unittest.TestCase):
    def test_export_download_keeps_browser_session(self):
        cookie = "wf_browser=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        content = b"WFOLIOBACKUP\0\0\0\x01test backup"
        root = "/api/v1/utilities/database"

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, body, *, status=200, session=False):
                self.send_response(status)
                if session:
                    self.send_header("Set-Cookie", cookie + "; Path=/; HttpOnly; SameSite=Strict")
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.path == root + "/backup":
                    self.respond(json.dumps({"filename": "snapshot.db"}).encode())
                elif self.path == root + "/backups/snapshot.db/export":
                    # Even a cookie first issued by export must reach download.
                    self.respond(b'{"id":"export-ticket"}', session=True)
                else:
                    self.respond(b"", status=404)

            def do_GET(self):
                if self.path == root + "/exports/export-ticket" and self.headers.get("Cookie") == cookie:
                    self.respond(content)
                else:
                    self.respond(b"", status=404)

            def do_PUT(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.respond(b"{}")

        with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                origin = f"http://127.0.0.1:{server.server_port}"
                self.assertEqual(portable_export(make_request(origin), True), content)
                # A new client must not inherit another client's export access.
                with self.assertRaises(urllib.error.HTTPError) as error:
                    make_request(origin)(root + "/exports/export-ticket")
                self.assertEqual(error.exception.code, 404)
                error.exception.close()
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
