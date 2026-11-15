import hmac
import os
from urllib.parse import parse_qs, urlsplit

from server import Handler

ROUTES = {"/speak", "/sentence", "/listen-token", "/guess"}
PRODUCTION_ORIGIN = "https://vexo-sage.vercel.app"


class handler(Handler):
    def do_GET(self):
        self.send_error(405)

    do_HEAD = do_GET

    def post_allowed(self):
        return self.headers.get("Origin") == PRODUCTION_ORIGIN

    def do_POST(self):
        parsed = urlsplit(self.path)
        route = parsed.path
        if route == "/api/vexo":
            route = "/" + parse_qs(parsed.query).get("route", [""])[0]
        if route not in ROUTES:
            return self.send_error(404)
        if not self.post_allowed():
            return self.send_error(403)
        expected = os.environ.get("VEXO_ACCESS_CODE")
        if not expected:
            return self.send_error(503, "Demo access code is not configured")
        submitted = self.headers.get("X-Vexo-Access-Code", "")
        if not hmac.compare_digest(submitted.encode(), expected.encode()):
            return self.send_error(401, "Demo access code required")
        self.path = route
        return super().do_POST()
