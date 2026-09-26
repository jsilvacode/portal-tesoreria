import json
import tempfile
import threading
import urllib.parse
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import app
import api.index as vercel_api


class CommitHandler(app.TreasuryHandler):
    def __init__(self, payload, user_id):
        self._payload = payload
        self._user = {"id": user_id, "role": "treasurer", "department_name": None}
        self.response = None

    def require_treasurer(self, conn):
        return self._user

    def parse_json_body(self):
        return self._payload

    def send_json(self, status, payload, cookie=None):
        self.response = (status, payload)


class AuditRequestHandler(app.TreasuryHandler):
    def __init__(self, path, user_id):
        self.path = path
        self.headers = {}
        self._user = {"id": user_id, "role": "treasurer", "department_name": None}
        self.response = None

    def require_treasurer(self, conn):
        return self._user

    def send_json(self, status, payload, cookie=None):
        self.response = (status, payload)


class ReportRequestHandler(app.TreasuryHandler):
    def __init__(self, path, user):
        self.path = path
        self.headers = {}
        self._user = user
        self.response = None

    def require_user(self, conn):
        return self._user

    def send_json(self, status, payload, cookie=None):
        self.response = (status, payload)


class AnonymousAdapterHandler(vercel_api.handler):
    def __init__(self):
        self.path = "/api?__route=%2Fapi%2Fme"
        self.headers = {"Cookie": ""}
        self.response = None

    def send_json(self, status, payload, cookie=None):
        self.response = (status, payload)


class TreasuryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="unach-synthetic-")
        self.db_path = Path(self.temporary.name) / "fixture.sqlite3"
        self.conn = app.connect(self.db_path)
        app.create_schema(self.conn)
        self.conn.execute(
            """INSERT INTO users(email, password_hash, role, department_name, status, created_at)
               VALUES (?, ?, 'treasurer', NULL, 'active', ?)""",
            ("tesorero@example.test", "test-only", app.utc_now()),
        )
        self.conn.executemany(
            "INSERT INTO departments(name, opening_balance, currency) VALUES (?, ?, ?)",
            [("Departamento Norte", 100_000, "CLP"), ("Departamento Sur", 50_000, "CLP")],
        )
        self._seed_transactions()
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.temporary.cleanup()

    def _insert(self, department, movement_date, amount, donor="", description=""):
        self.conn.execute(
            """INSERT INTO transactions(
               source_row, department_name, opening_balance, movement_type, movement_date,
               event_date, amount, description, donor_name, currency
               ) VALUES (?, ?, 0, 'Ingreso', ?, ?, ?, ?, ?, 'CLP')""",
            (1, department, movement_date, movement_date, amount, description, donor),
        )

    def _seed_transactions(self):
        self._insert("Departamento Norte", "2026-01-31", 100, description="Enero")
        self._insert("Departamento Norte", "2026-02-10", 200, description="Febrero")
        self._insert("Departamento Norte", "2026-03-15", -50, description="Marzo")
        for day in range(1, 32):
            movement_day = min(day, 30)
            donor = "José Álvarez" if day == 4 else "Persona de prueba"
            self._insert(
                "Departamento Norte",
                "2026-09-{:02d}".format(movement_day),
                100,
                donor=donor,
                description="Aporte curado {}".format(day),
            )
        self._insert("Departamento Sur", "2026-09-30", -500, description="Egreso de prueba")

    def test_summary_uses_constant_number_of_queries_and_keeps_skipped_months_in_closing(self):
        statements = []
        self.conn.set_trace_callback(statements.append)
        report = app.get_summary(
            self.conn, "2026-01-01", "2026-09-30", year=2026, months=[1, 3]
        )
        selects = [sql for sql in statements if sql.lstrip().upper().startswith("SELECT")]
        self.assertEqual(len(selects), 3)
        self.assertEqual(len(report["departments"]), 2)
        self.assertEqual([row["month"] for row in report["monthly"]], ["2026-01", "2026-03"])
        self.assertEqual(report["totals"]["net"], 50)
        # February is outside the selected movement net, but remains in the real closing balance.
        self.assertEqual(report["totals"]["closing"], 150_250)

    def test_empty_period_compiles_to_portable_false_and_returns_no_rows(self):
        self.assertEqual(app.intervals_sql("movement_date", []), ("1 = 0", []))
        report = app.get_summary(
            self.conn, "2026-01-01", "2026-09-30", year=2025, months=[4]
        )
        page = app.get_transactions_page(
            self.conn, "2026-01-01", "2026-09-30", year=2025, months=[4]
        )
        self.assertTrue(report["filters"]["emptySelection"])
        self.assertEqual(report["totals"]["rows"], 0)
        self.assertEqual(page["transactions"], [])
        self.assertEqual(page["total"], 0)

    def test_sql_pagination_preserves_scope_running_balance_and_duplicate_dates(self):
        first = app.get_transactions_page(
            self.conn, "2026-01-01", "2026-09-30", "Departamento Norte",
            page_size=25,
        )
        self.assertEqual(first["total"], 34)
        self.assertEqual(len(first["transactions"]), 25)
        self.assertTrue(first["hasMore"])
        last_first_page = first["transactions"][-1]
        second = app.get_transactions_page(
            self.conn, "2026-01-01", "2026-09-30", "Departamento Norte",
            page_size=25,
            page=2,
            cursor=(last_first_page["movement_date"], last_first_page["id"]),
        )
        self.assertEqual(len(second["transactions"]), 9)
        self.assertFalse(second["hasMore"])
        combined = first["transactions"] + second["transactions"]
        self.assertEqual(len({row["id"] for row in combined}), 34)
        self.assertTrue(all(row["department_name"] == "Departamento Norte" for row in combined))
        self.assertEqual(
            [(row["movement_date"], row["id"]) for row in combined],
            sorted(
                [(row["movement_date"], row["id"]) for row in combined],
                reverse=True,
            ),
        )
        september_rows = [row for row in combined if row["movement_date"].startswith("2026-09")]
        self.assertEqual(september_rows[0]["running_balance"], 103_350)

    def test_database_search_is_accent_and_amount_aware_before_pagination(self):
        people = app.get_transactions_page(
            self.conn, "2026-01-01", "2026-09-30", search="jose alvarez"
        )
        self.assertEqual(people["total"], 1)
        self.assertEqual(people["transactions"][0]["donor_name"], "José Álvarez")
        amount = app.get_transactions_page(
            self.conn, "2026-01-01", "2026-09-30", search="100"
        )
        self.assertGreater(amount["total"], 1)
        self.assertLessEqual(len(amount["transactions"]), 25)

    def test_import_token_is_idempotent_after_success(self):
        user_id = self.conn.execute(
            "SELECT id FROM users WHERE email = ?", ("tesorero@example.test",)
        ).fetchone()["id"]
        record = {
            "source_row": 2,
            "department_id": "D-1",
            "department_name": "Departamento Norte",
            "opening_balance": 100_000,
            "movement_type_number": 1,
            "movement_type": "Ingreso",
            "movement_date": "2027-01-01",
            "event_date": "2027-01-01",
            "amount": 100,
            "description": "Nuevo aporte",
            "base_person_id": "P-1",
            "server_id": "S-9",
            "donor_name": "Persona",
            "currency": "CLP",
            "total_by_currency": 100,
            "observations": "",
        }
        self.conn.execute(
            """INSERT INTO import_previews(token, filename, file_sha256, row_count, created_by, created_at)
               VALUES ('preview-1', 'carga.xlsx', 'hash-1', 1, ?, ?)""",
            (user_id, app.utc_now()),
        )
        self.conn.execute(
            "INSERT INTO import_staging(preview_token, record_json) VALUES (?, ?)",
            ("preview-1", json.dumps(record)),
        )
        self.conn.commit()
        barrier = threading.Barrier(2)

        def commit_once():
            connection = app.connect(self.db_path)
            handler = CommitHandler({"preview_token": "preview-1"}, user_id)
            try:
                barrier.wait(timeout=5)
                handler.handle_import_commit(connection)
                return handler.response
            finally:
                connection.close()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: commit_once(), range(2)))
        self.assertEqual(sorted(status for status, _ in results), [200, 201])
        first_batch = next(payload["batch_id"] for status, payload in results if status == 201)
        already_done = next(payload for status, payload in results if status == 200)
        self.assertTrue(already_done["already_completed"])
        self.assertEqual(already_done["batch_id"], first_batch)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM import_batches").fetchone()[0], 1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0], 36)

    def test_new_department_requires_treasurer_review_before_import(self):
        user_id = self.conn.execute(
            "SELECT id FROM users WHERE email = ?", ("tesorero@example.test",)
        ).fetchone()["id"]
        record = {
            "source_row": 2,
            "department_id": "D-new",
            "department_name": "Departamento Nuevo",
            "opening_balance": 0,
            "movement_type_number": 1,
            "movement_type": "Ingreso",
            "movement_date": "2027-02-01",
            "event_date": "2027-02-01",
            "amount": 100,
            "description": "Aporte",
            "base_person_id": "",
            "server_id": "",
            "donor_name": "Persona",
            "currency": "CLP",
            "total_by_currency": 100,
            "observations": "",
        }
        self.conn.execute(
            """INSERT INTO import_previews(token, filename, file_sha256, row_count, created_by, created_at)
               VALUES ('preview-new-dept', 'carga.xlsx', 'hash-new-dept', 1, ?, ?)""",
            (user_id, app.utc_now()),
        )
        self.conn.execute(
            "INSERT INTO import_staging(preview_token, record_json) VALUES (?, ?)",
            ("preview-new-dept", json.dumps(record)),
        )
        self.conn.commit()

        first_conn = app.connect(self.db_path)
        first = CommitHandler({"preview_token": "preview-new-dept"}, user_id)
        first.handle_import_commit(first_conn)
        first_conn.close()
        self.assertEqual(first.response[0], 409)
        self.assertIn("new_departments", first.response[1]["requires_confirmation"])

        second_conn = app.connect(self.db_path)
        second = CommitHandler(
            {"preview_token": "preview-new-dept", "confirm_new_departments": True}, user_id
        )
        second.handle_import_commit(second_conn)
        second_conn.close()
        self.assertEqual(second.response[0], 201)
        self.assertTrue(self.conn.execute(
            "SELECT 1 FROM departments WHERE name = 'Departamento Nuevo'"
        ).fetchone())

    def test_upgrade_adds_preview_state_to_preexisting_schema(self):
        old = app.connect(Path(self.temporary.name) / "old.sqlite3")
        old.executescript(
            """CREATE TABLE import_previews (
                 token TEXT PRIMARY KEY, filename TEXT NOT NULL, file_sha256 TEXT NOT NULL,
                 row_count INTEGER NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL
               );
               CREATE TABLE import_staging (
                 id INTEGER PRIMARY KEY AUTOINCREMENT, preview_token TEXT NOT NULL, record_json TEXT NOT NULL
               );
               CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);"""
        )
        app.apply_migrations(old)
        columns = {row["name"] for row in old.execute("PRAGMA table_info(import_previews)")}
        self.assertTrue({"status", "result_batch_id", "completed_at"}.issubset(columns))
        indexes = {row["name"] for row in old.execute("PRAGMA index_list(import_staging)")}
        self.assertIn("idx_import_staging_token_id", indexes)
        old.close()

    def test_audit_filters_department_date_and_search_before_returning_pages(self):
        user_id = self.conn.execute(
            "SELECT id FROM users WHERE email = ?", ("tesorero@example.test",)
        ).fetchone()["id"]
        local_day = app.datetime.now(app.LOCAL_TIMEZONE).date().isoformat()
        created_at = app.datetime.combine(
            app.date.fromisoformat(local_day), app.datetime.min.time().replace(hour=12),
            app.LOCAL_TIMEZONE,
        ).astimezone(app.timezone.utc).isoformat()
        for index in range(200):
            detail = (
                {"department": "Departamento Norte", "marker": "needle-antiguo"}
                if index == 0
                else {"department": "Departamento Sur", "marker": "rutina"}
            )
            self.conn.execute(
                """INSERT INTO audit_log(user_id, event_type, detail, created_at)
                   VALUES (?, 'report_viewed', ?, ?)""",
                (user_id, json.dumps(detail), created_at),
            )
        self.conn.commit()
        params = urllib.parse.urlencode({
            "start": local_day,
            "end": local_day,
            "department": "Departamento Norte",
            "q": "needle antiguo",
        })
        request = AuditRequestHandler("/api/admin/audit?" + params, user_id)
        connector = app.connect
        with patch("app.connect", side_effect=lambda: connector(self.db_path)):
            request.do_GET()
        self.assertEqual(request.response[0], 200)
        self.assertEqual(request.response[1]["total"], 1)
        self.assertEqual(len(request.response[1]["events"]), 1)
        self.assertTrue(request.response[1]["hasMore"] is False)
        self.assertIn("needle-antiguo", request.response[1]["events"][0]["detail"])

    def test_summary_endpoint_applies_department_and_inclusive_date_range(self):
        treasurer = {"id": 1, "role": "treasurer", "department_name": None}
        request = ReportRequestHandler(
            "/api/summary?start=2026-09-30&end=2026-09-30&department=Departamento+Sur",
            treasurer,
        )
        connector = app.connect
        with patch("app.connect", side_effect=lambda: connector(self.db_path)):
            request.do_GET()

        self.assertEqual(request.response[0], 200)
        report = request.response[1]
        self.assertEqual([row["department"] for row in report["departments"]], ["Departamento Sur"])
        self.assertEqual(report["period"], {"start": "2026-09-30", "end": "2026-09-30"})
        self.assertEqual(report["totals"]["rows"], 1)
        self.assertEqual(report["totals"]["net"], -500)

    def test_department_user_cannot_filter_detail_to_another_department(self):
        department_user = {"id": 2, "role": "department", "department_name": "Departamento Norte"}
        request = ReportRequestHandler(
            "/api/transactions?start=2026-09-30&end=2026-09-30&department=Departamento+Sur",
            department_user,
        )
        connector = app.connect
        with patch("app.connect", side_effect=lambda: connector(self.db_path)):
            request.do_GET()

        self.assertEqual(request.response[0], 403)
        self.assertEqual(request.response[1]["error"], "No tienes acceso a ese departamento.")

    def test_anonymous_session_check_returns_before_opening_a_database(self):
        request = AnonymousAdapterHandler()
        with patch("app.connect", side_effect=AssertionError("database should stay unopened")):
            request.do_GET()
        self.assertEqual(request.response, (200, {"user": None}))

    def test_timing_headers_expose_durations_without_user_data(self):
        request = object.__new__(app.TreasuryHandler)
        request._request_id = "synthetic-request-id"
        request._request_started = app.time.perf_counter() - 0.01
        request._active_connection = self.conn
        headers = []
        request.send_header = lambda key, value: headers.append((key, value))

        request._observability_headers()

        values = dict(headers)
        self.assertEqual(values["X-Request-ID"], "synthetic-request-id")
        self.assertIn("connect;dur=", values["Server-Timing"])
        self.assertIn("db;dur=", values["Server-Timing"])
        self.assertIn("app;dur=", values["Server-Timing"])
        self.assertNotIn("@", values["Server-Timing"])

    def test_large_50000_row_fixture_keeps_summary_queries_and_detail_page_bounded(self):
        path = Path(self.temporary.name) / "large.sqlite3"
        conn = app.connect(path)
        app.create_schema(conn)
        names = ["Departamento {:02d}".format(index) for index in range(39)]
        conn.executemany(
            "INSERT INTO departments(name, opening_balance, currency) VALUES (?, 0, 'CLP')",
            [(name,) for name in names],
        )
        sql = """INSERT INTO transactions(
                 source_row, department_name, opening_balance, movement_type, movement_date,
                 event_date, amount, description, donor_name, currency
               ) VALUES (?, ?, 0, 'Ingreso', ?, ?, 100, ?, 'Fixture sintético', 'CLP')"""

        def insert_range(start, stop):
            for offset in range(start, stop, 1000):
                rows = []
                for sequence in range(offset, min(offset + 1000, stop)):
                    movement_date = "2026-09-{:02d}".format(sequence % 30 + 1)
                    rows.append((
                        sequence + 1,
                        names[sequence % len(names)],
                        movement_date,
                        movement_date,
                        "Movimiento {}".format(sequence + 1),
                    ))
                conn.executemany(sql, rows)

        insert_range(0, 12_480)
        conn.commit()

        conn.query_count = 0
        report = app.get_summary(conn, "2026-09-01", "2026-09-30")
        summary_queries = conn.query_count
        self.assertEqual(summary_queries, 3)
        self.assertEqual(len(report["departments"]), 39)
        self.assertEqual(report["totals"]["rows"], 12_480)

        conn.query_count = 0
        page = app.get_transactions_page(conn, "2026-09-01", "2026-09-30")
        detail_queries = conn.query_count
        self.assertEqual(detail_queries, 1)
        self.assertEqual(page["total"], 12_480)
        self.assertEqual(len(page["transactions"]), 25)
        self.assertTrue(page["hasMore"])

        insert_range(12_480, 50_000)
        conn.commit()
        conn.query_count = 0
        large_report = app.get_summary(conn, "2026-09-01", "2026-09-30")
        self.assertEqual(conn.query_count, 3)
        self.assertEqual(large_report["totals"]["rows"], 50_000)
        conn.query_count = 0
        large_page = app.get_transactions_page(conn, "2026-09-01", "2026-09-30")
        self.assertEqual(conn.query_count, 1)
        self.assertEqual(large_page["total"], 50_000)
        self.assertEqual(len(large_page["transactions"]), 25)
        conn.close()


if __name__ == "__main__":
    unittest.main()
