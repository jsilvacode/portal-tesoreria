"""Vercel serverless adapter for the existing treasury request handler."""

from __future__ import annotations

import os
import re
import traceback
import urllib.parse

from app import TreasuryHandler


def _restore_original_path(request_handler: TreasuryHandler) -> None:
    parsed = urllib.parse.urlsplit(request_handler.path)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    original_path = next((value for key, value in query if key == "__route"), None)
    if not original_path or not original_path.startswith("/api/"):
        return
    passthrough = [(key, value) for key, value in query if key != "__route"]
    request_handler.path = urllib.parse.unquote(original_path)
    if passthrough:
        request_handler.path += "?" + urllib.parse.urlencode(passthrough, doseq=True)


def _prepare_request(request_handler: TreasuryHandler) -> bool:
    if not os.environ.get("DATABASE_URL", "").strip():
        request_handler.send_json(
            503,
            {"error": "El servicio aún no tiene una base de datos de producción configurada."},
        )
        return False
    try:
        _restore_original_path(request_handler)
        return True
    except Exception:
        traceback.print_exc()
        request_handler.send_json(
            503,
            {"error": "El servicio financiero no está disponible. Revisa la configuración de producción."},
        )
        return False


class handler(TreasuryHandler):
    def do_GET(self):
        _restore_original_path(self)
        path = urllib.parse.urlsplit(self.path).path
        session_cookie = re.search(
            r"(?:^|;\s*)unach_session=[^;\s]+", self.headers.get("Cookie", "")
        )
        if path == "/api/me" and not session_cookie:
            self.send_json(200, {"user": None})
            return
        if _prepare_request(self):
            super().do_GET()

    def do_POST(self):
        if _prepare_request(self):
            super().do_POST()
