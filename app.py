#!/usr/bin/env python3
"""UNACH treasury reporting application."""

from __future__ import annotations

import base64
import calendar
import hashlib
import html
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import time
import traceback
import unicodedata
import urllib.parse
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

def _openpyxl():
    try:
        from openpyxl import Workbook, load_workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
    except ImportError as exc:
        raise RuntimeError("Falta openpyxl. Ejecuta: python3 -m pip install -r requirements.txt") from exc
    return Workbook, load_workbook, Alignment, Font, PatternFill, get_column_letter


def _reportlab():
    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_LEFT, TA_RIGHT
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import LongTable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except ImportError as exc:
        raise RuntimeError("Falta reportlab para exportar PDF.") from exc
    return (colors, TA_LEFT, TA_RIGHT, A4, landscape, ParagraphStyle,
            getSampleStyleSheet, mm, LongTable, Paragraph, SimpleDocTemplate,
            Spacer, Table, TableStyle)


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "tesoreria-local.sqlite3"
SOURCE_PATH = ROOT / "documentos-base" / "reporte-contable-2026-09-22.xlsx"
if os.environ.get("UNACH_DB_PATH"):
    DB_PATH = Path(os.environ["UNACH_DB_PATH"])
if os.environ.get("UNACH_SOURCE_PATH"):
    SOURCE_PATH = Path(os.environ["UNACH_SOURCE_PATH"])
HOST = os.environ.get("UNACH_HOST", "127.0.0.1")
PORT = int(os.environ.get("UNACH_PORT", "8000"))
SESSION_SECONDS = 12 * 60 * 60
MAX_UPLOAD_BYTES = 4 * 1024 * 1024 if os.environ.get("VERCEL") else 25 * 1024 * 1024
MAX_IMPORT_ROWS = 50_000
PBKDF2_ITERATIONS = 310_000
LOCAL_TIMEZONE = ZoneInfo("America/Santiago")
MONTH_NAMES_ES = (
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
)
EXPECTED_HEADERS = (
    "DEPARTMENT_ID",
    "Nombre del Departamento",
    "Balance Inicial",
    "MOVEMENT_TYPE_NUMBER",
    "Tipo Movimiento",
    "Fecha Movimiento",
    "Fecha del Evento",
    "Valor",
    "Descripción",
    "BASE PERSON ID",
    "SERVER ID",
    "Nombre del Diezmante y Ofrendante",
    "Símbolo de la Moneda",
    "TOTAL BY CURRENCY",
    "Observaciones",
)
IMPORT_MATCH_FIELDS = (
    "department_id",
    "department_name",
    "opening_balance",
    "movement_type_number",
    "movement_type",
    "movement_date",
    "event_date",
    "amount",
    "description",
    "base_person_id",
    "server_id",
    "donor_name",
    "currency",
    "total_by_currency",
    "observations",
)
IMPORT_MATCH_SAMPLE_LIMIT = 200


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_text(value) -> str:
    return "" if value is None else str(value).strip()


def normalize_search_text(value) -> str:
    decomposed = unicodedata.normalize("NFKD", str(value or "")).casefold()
    without_marks = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", without_marks).strip()


def parse_date(value) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    raw = normalize_text(value)
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError("fecha inválida; se espera DD/MM/AAAA")


def parse_money(value, field_name: str) -> int:
    if value is None or normalize_text(value) == "":
        return 0
    try:
        amount = Decimal(str(value).replace(",", "."))
    except InvalidOperation as exc:
        raise ValueError(field_name + " no es numérico") from exc
    minor_units = amount * 100
    if minor_units != minor_units.to_integral_value():
        raise ValueError(field_name + " supera los dos decimales admitidos")
    return int(minor_units)


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    return "pbkdf2_sha256$" + str(PBKDF2_ITERATIONS) + "$" + \
        base64.urlsafe_b64encode(salt).decode("ascii") + "$" + \
        base64.urlsafe_b64encode(derived).decode("ascii")


class PostgresCursor:
    def __init__(self, cursor, lastrowid=None, prefetched=None, owner=None):
        self._cursor = cursor
        self.lastrowid = lastrowid
        self._prefetched = prefetched
        self._owner = owner

    def fetchone(self):
        if self._prefetched is not None:
            row, self._prefetched = self._prefetched, None
            return row
        started = time.perf_counter()
        try:
            return self._cursor.fetchone()
        finally:
            if self._owner:
                self._owner.query_duration_ms += (time.perf_counter() - started) * 1000

    def fetchall(self):
        started = time.perf_counter()
        rows = self._cursor.fetchall()
        if self._owner:
            self._owner.query_duration_ms += (time.perf_counter() - started) * 1000
        if self._prefetched is not None:
            rows.insert(0, self._prefetched)
            self._prefetched = None
        return rows

    def __iter__(self):
        return self

    def __next__(self):
        row = self.fetchone()
        if row is None:
            raise StopIteration
        return row

    @property
    def rowcount(self):
        return self._cursor.rowcount


class InstrumentedCursor:
    def __init__(self, cursor, owner):
        self._cursor = cursor
        self._owner = owner

    def fetchone(self):
        started = time.perf_counter()
        try:
            return self._cursor.fetchone()
        finally:
            self._owner.query_duration_ms += (time.perf_counter() - started) * 1000

    def fetchall(self):
        started = time.perf_counter()
        try:
            return self._cursor.fetchall()
        finally:
            self._owner.query_duration_ms += (time.perf_counter() - started) * 1000

    def __iter__(self):
        return self

    def __next__(self):
        row = self.fetchone()
        if row is None:
            raise StopIteration
        return row

    def __getattr__(self, name):
        return getattr(self._cursor, name)


class HybridRow(dict):
    """PostgreSQL row that supports both named and positional SQLite access."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return tuple(self.values())[key]
        return super().__getitem__(key)


def postgres_row_factory(cursor):
    # psycopg asks for a row factory even when a statement has no result set
    # (for example, CREATE TABLE). In that case there is no description.
    description = cursor.description
    if description is None:
        return lambda values: values
    names = [column.name for column in description]
    return lambda values: HybridRow(zip(names, values))


class PostgresConnection:
    """Small compatibility layer for the SQLite queries used by this app."""

    _ID_TABLES = {"users", "import_batches"}

    def __init__(self, connection, psycopg):
        self._connection = connection
        self._psycopg = psycopg
        self.query_count = 0
        self.query_duration_ms = 0.0
        self.connect_duration_ms = 0.0

    def execute(self, sql: str, parameters=()):
        sql = sql.strip()
        if re.match(r"^PRAGMA\b", sql, re.IGNORECASE):
            return PostgresCursor(None)
        ignored_conflict = bool(
            re.match(r"^INSERT\s+OR\s+IGNORE\s+INTO\b", sql, re.IGNORECASE)
        )
        if ignored_conflict:
            sql = re.sub(
                r"^INSERT\s+OR\s+IGNORE\s+INTO\b",
                "INSERT INTO",
                sql,
                count=1,
                flags=re.IGNORECASE,
            ).rstrip().rstrip(";")
            sql += " ON CONFLICT DO NOTHING"
        table_match = re.match(r"^INSERT\s+INTO\s+([a-z_]+)\b", sql, re.IGNORECASE)
        return_id = bool(
            table_match
            and table_match.group(1).lower() in self._ID_TABLES
            and not re.search(r"\bRETURNING\b", sql, re.IGNORECASE)
        )
        if return_id:
            sql = sql.rstrip().rstrip(";") + " RETURNING id"
        sql = sql.replace("?", "%s")
        started = time.perf_counter()
        try:
            cursor = self._connection.execute(sql, tuple(parameters))
            if return_id:
                row = cursor.fetchone()
                return PostgresCursor(cursor, row["id"] if row else None, row, self)
            return PostgresCursor(cursor, owner=self)
        except self._psycopg.IntegrityError as exc:
            self._connection.rollback()
            raise sqlite3.IntegrityError(str(exc)) from exc
        finally:
            self.query_count += 1
            self.query_duration_ms += (time.perf_counter() - started) * 1000

    def executemany(self, sql: str, parameters):
        """Run a parameterized batch efficiently for PostgreSQL imports."""
        sql = sql.strip().replace("?", "%s")
        started = time.perf_counter()
        try:
            cursor = self._connection.cursor()
            cursor.executemany(sql, parameters)
            return PostgresCursor(cursor, owner=self)
        except self._psycopg.IntegrityError as exc:
            self._connection.rollback()
            raise sqlite3.IntegrityError(str(exc)) from exc
        finally:
            self.query_count += 1
            self.query_duration_ms += (time.perf_counter() - started) * 1000

    def executescript(self, script: str):
        schema = re.sub(
            r"\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b",
            "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
            script,
            flags=re.IGNORECASE,
        )
        schema = re.sub(r"\bINTEGER\b", "BIGINT", schema, flags=re.IGNORECASE)
        schema = re.sub(r"\s+COLLATE\s+NOCASE\b", "", schema, flags=re.IGNORECASE)
        for statement in schema.split(";"):
            if statement.strip():
                self.execute(statement)

    def commit(self):
        self._connection.commit()

    def rollback(self):
        self._connection.rollback()

    def close(self):
        self._connection.close()


class InstrumentedSQLiteConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.query_count = 0
        self.query_duration_ms = 0.0
        self.connect_duration_ms = 0.0

    def execute(self, sql, parameters=()):
        started = time.perf_counter()
        try:
            cursor = super().execute(sql, parameters)
            return InstrumentedCursor(cursor, self)
        finally:
            self.query_count += 1
            self.query_duration_ms += (time.perf_counter() - started) * 1000

    def executemany(self, sql, parameters):
        started = time.perf_counter()
        try:
            cursor = super().executemany(sql, parameters)
            return InstrumentedCursor(cursor, self)
        finally:
            self.query_count += 1
            self.query_duration_ms += (time.perf_counter() - started) * 1000

    def executescript(self, sql):
        started = time.perf_counter()
        try:
            return super().executescript(sql)
        finally:
            self.query_count += 1
            self.query_duration_ms += (time.perf_counter() - started) * 1000


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iterations, salt, expected = stored.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        derived = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            base64.urlsafe_b64decode(salt.encode("ascii")),
            int(iterations),
        )
        return secrets.compare_digest(
            base64.urlsafe_b64encode(derived).decode("ascii"), expected
        )
    except (ValueError, TypeError):
        return False


def uses_postgres(db_path: Path | str | None = None) -> bool:
    target = Path(db_path) if db_path is not None else DB_PATH
    return bool(os.environ.get("DATABASE_URL", "").strip()) and (
        db_path is None or target == DB_PATH
    )


def connect(db_path: Path | str | None = None):
    target = Path(db_path) if db_path is not None else DB_PATH
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if uses_postgres(db_path):
        try:
            import psycopg
        except ImportError as exc:
            raise RuntimeError("Falta psycopg para conectar con PostgreSQL.") from exc
        started = time.perf_counter()
        connection = psycopg.connect(
            database_url,
            connect_timeout=10,
            sslmode="require",
            prepare_threshold=None,
            row_factory=postgres_row_factory,
        )
        wrapped = PostgresConnection(connection, psycopg)
        wrapped.connect_duration_ms = (time.perf_counter() - started) * 1000
        return wrapped
    started = time.perf_counter()
    conn = sqlite3.connect(str(target), timeout=20, factory=InstrumentedSQLiteConnection)
    conn.connect_duration_ms = (time.perf_counter() - started) * 1000
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 20000")
    conn.create_function(
        "digits_only", 1,
        lambda value: re.sub(r"\D", "", str(value or "")),
        deterministic=True,
    )
    conn.create_function("normalize_search", 1, normalize_search_text, deterministic=True)
    return conn


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS departments (
            name TEXT PRIMARY KEY,
            opening_balance INTEGER NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'Chilean Peso $'
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('treasurer', 'department')),
            department_name TEXT REFERENCES departments(name),
            status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'inactive')),
            created_at TEXT NOT NULL,
            approved_at TEXT,
            CHECK((role = 'treasurer' AND department_name IS NULL) OR
                  (role = 'department' AND department_name IS NOT NULL))
        );
        CREATE TABLE IF NOT EXISTS import_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            file_sha256 TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            imported_by INTEGER REFERENCES users(id),
            imported_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id INTEGER REFERENCES import_batches(id),
            source_row INTEGER NOT NULL,
            department_id TEXT,
            department_name TEXT NOT NULL REFERENCES departments(name),
            opening_balance INTEGER NOT NULL,
            movement_type_number INTEGER,
            movement_type TEXT NOT NULL,
            movement_date TEXT NOT NULL,
            event_date TEXT NOT NULL,
            amount INTEGER NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            base_person_id TEXT NOT NULL DEFAULT '',
            server_id TEXT NOT NULL DEFAULT '',
            donor_name TEXT NOT NULL DEFAULT '',
            currency TEXT NOT NULL DEFAULT 'Chilean Peso $',
            total_by_currency INTEGER,
            observations TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_transactions_department_date
            ON transactions(department_name, movement_date, id);
        CREATE INDEX IF NOT EXISTS idx_transactions_date
            ON transactions(movement_date, id);
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER REFERENCES users(id),
            event_type TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
        CREATE TABLE IF NOT EXISTS import_previews (
            token TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            file_sha256 TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            created_by INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'ready',
            result_batch_id INTEGER REFERENCES import_batches(id),
            completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS import_staging (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            preview_token TEXT NOT NULL REFERENCES import_previews(token) ON DELETE CASCADE,
            record_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_import_staging_token_id
            ON import_staging(preview_token, id);
        CREATE INDEX IF NOT EXISTS idx_import_previews_created
            ON import_previews(created_at);
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
        """
    )
    if isinstance(conn, PostgresConnection):
        columns = {
            row["column_name"]
            for row in conn.execute(
                """SELECT column_name FROM information_schema.columns
                   WHERE table_schema = current_schema() AND table_name = 'transactions'"""
            ).fetchall()
        }
    else:
        columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(transactions)").fetchall()
    }
    if "department_id" not in columns:
        if isinstance(conn, PostgresConnection):
            conn.execute("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS department_id TEXT")
        else:
            conn.execute("ALTER TABLE transactions ADD COLUMN department_id TEXT")
    apply_migrations(conn)


def apply_migrations(conn) -> None:
    """Apply small additive schema changes outside request handling."""
    preview_columns = set()
    if isinstance(conn, PostgresConnection):
        preview_columns = {
            row["column_name"] for row in conn.execute(
                """SELECT column_name FROM information_schema.columns
                   WHERE table_schema = current_schema() AND table_name = 'import_previews'"""
            ).fetchall()
        }
    else:
        preview_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(import_previews)").fetchall()
        }
    if "status" not in preview_columns:
        conn.execute("ALTER TABLE import_previews ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'")
    if "result_batch_id" not in preview_columns:
        conn.execute("ALTER TABLE import_previews ADD COLUMN result_batch_id INTEGER")
    if "completed_at" not in preview_columns:
        conn.execute("ALTER TABLE import_previews ADD COLUMN completed_at TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_import_staging_token_id ON import_staging(preview_token, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_import_previews_created ON import_previews(created_at)")
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        (1, utc_now()),
    )
    conn.commit()


def record_audit(
    conn: sqlite3.Connection,
    user_id: int | None,
    event_type: str,
    detail: dict | None = None,
) -> None:
    conn.execute(
        "INSERT INTO audit_log(user_id, event_type, detail, created_at) VALUES (?, ?, ?, ?)",
        (user_id, event_type, json.dumps(detail or {}, ensure_ascii=False), utc_now()),
    )


def session_metadata(conn, user: dict | None) -> dict:
    dates = conn.execute(
        "SELECT MIN(movement_date) AS start, MAX(movement_date) AS end FROM transactions"
    ).fetchone()
    return {
        "user": user,
        "dateRange": {"start": dates["start"], "end": dates["end"]},
        "departments": [
            row["name"] for row in conn.execute("SELECT name FROM departments ORDER BY name")
        ],
    }


def import_records_from_xlsx(file_bytes: bytes) -> list[dict]:
    _, load_workbook, *_ = _openpyxl()
    workbook = load_workbook(io.BytesIO(file_bytes), data_only=True, read_only=True)
    sheet = workbook[workbook.sheetnames[0]]
    rows = sheet.iter_rows(values_only=True)
    try:
        header_row = next(rows)
    except StopIteration as exc:
        raise ValueError("El archivo no contiene filas.") from exc
    headers = tuple(normalize_text(cell) for cell in header_row)
    missing = [name for name in EXPECTED_HEADERS if name not in headers]
    if missing:
        raise ValueError("Faltan cabeceras obligatorias: " + ", ".join(missing))
    positions = {name: headers.index(name) for name in EXPECTED_HEADERS}
    result = []
    errors = []
    for row_number, row in enumerate(rows, start=2):
        if not any(cell is not None and normalize_text(cell) for cell in row):
            continue
        if len(result) >= MAX_IMPORT_ROWS:
            raise ValueError("El archivo supera el máximo admitido de 50.000 filas.")
        raw = {
            name: row[positions[name]] if positions[name] < len(row) else None
            for name in EXPECTED_HEADERS
        }
        try:
            department = normalize_text(raw["Nombre del Departamento"])
            if not department:
                raise ValueError("falta el departamento")
            movement_date = parse_date(raw["Fecha Movimiento"])
            event_date = parse_date(raw["Fecha del Evento"])
            amount = parse_money(raw["Valor"], "Valor")
            opening = parse_money(raw["Balance Inicial"], "Balance Inicial")
            total = parse_money(raw["TOTAL BY CURRENCY"], "TOTAL BY CURRENCY")
            type_number = raw["MOVEMENT_TYPE_NUMBER"]
            type_number = int(type_number) if type_number is not None and normalize_text(type_number) else None
            result.append(
                {
                    "source_row": row_number,
                    "department_id": normalize_text(raw["DEPARTMENT_ID"]),
                    "department_name": department,
                    "opening_balance": opening,
                    "movement_type_number": type_number,
                    "movement_type": normalize_text(raw["Tipo Movimiento"]),
                    "movement_date": movement_date,
                    "event_date": event_date,
                    "amount": amount,
                    "description": normalize_text(raw["Descripción"]),
                    "base_person_id": normalize_text(raw["BASE PERSON ID"]),
                    "server_id": normalize_text(raw["SERVER ID"]),
                    "donor_name": normalize_text(raw["Nombre del Diezmante y Ofrendante"]),
                    "currency": normalize_text(raw["Símbolo de la Moneda"]) or "Chilean Peso $",
                    "total_by_currency": total,
                    "observations": normalize_text(raw["Observaciones"]),
                }
            )
        except (ValueError, TypeError, OverflowError) as exc:
            if len(errors) < 12:
                errors.append("Fila {}: {}".format(row_number, exc))
    workbook.close()
    if errors:
        raise ValueError("No se pudo validar el archivo:\n" + "\n".join(errors))
    if not result:
        raise ValueError("No se encontraron movimientos para importar.")
    return result


def import_match_key(record: dict, fields=IMPORT_MATCH_FIELDS) -> tuple:
    return tuple(record.get(field) for field in fields)


def import_preview_text(value, limit: int) -> str:
    return normalize_text(value)[:limit]


def import_review_sample(record: dict, match: dict, comparison: str) -> dict:
    return {
        "file_row": record["source_row"],
        "department": record["department_name"],
        "date": record["movement_date"],
        "event_date": record["event_date"],
        "amount": record["amount"],
        "movement_type": record["movement_type"],
        "description": import_preview_text(record["description"], 240),
        "person": import_preview_text(record["donor_name"], 120),
        "base_person_id": import_preview_text(record["base_person_id"], 80),
        "server_id": import_preview_text(record["server_id"], 80),
        "department_id": import_preview_text(record.get("department_id", ""), 80),
        "comparison": comparison,
        "previous_file": import_preview_text(match.get("filename", "Carga anterior"), 120),
        "previous_row": match.get("source_row"),
        "previous_department_id": import_preview_text(match.get("department_id"), 80),
    }


def analyze_import(conn, records: list[dict]) -> dict:
    start = min(record["movement_date"] for record in records)
    end = max(record["movement_date"] for record in records)
    batches = conn.execute(
        """SELECT b.id, b.filename, MIN(t.movement_date) AS start,
                  MAX(t.movement_date) AS end, COUNT(t.id) AS rows
           FROM import_batches b JOIN transactions t ON t.batch_id = b.id
           GROUP BY b.id, b.filename
           HAVING MAX(t.movement_date) >= ? AND MIN(t.movement_date) <= ?
           ORDER BY MAX(t.movement_date) DESC, b.id DESC""",
        (start, end),
    ).fetchall()
    overlaps = []
    for batch in batches:
        overlaps.append(
            {
                "filename": batch["filename"],
                "start": batch["start"],
                "end": batch["end"],
                "overlap_start": max(start, batch["start"]),
                "overlap_end": min(end, batch["end"]),
                "rows": batch["rows"],
            }
        )

    existing_exact = {}
    existing_without_department_id = {}
    existing_rows = conn.execute(
        """SELECT t.department_id, t.department_name, t.opening_balance,
                  t.movement_type_number, t.movement_type, t.movement_date,
                  t.event_date, t.amount, t.description, t.base_person_id,
                  t.server_id, t.donor_name, t.currency, t.total_by_currency,
                  t.observations, t.source_row, b.filename
           FROM transactions t LEFT JOIN import_batches b ON b.id = t.batch_id
           WHERE t.movement_date >= ? AND t.movement_date <= ?""",
        (start, end),
    ).fetchall()
    core_fields = tuple(field for field in IMPORT_MATCH_FIELDS if field != "department_id")
    for row in existing_rows:
        stored = dict(row)
        origin = {
            "filename": stored.get("filename") or "Carga previa sin archivo asociado",
            "source_row": stored.get("source_row"),
            "department_id": stored.get("department_id"),
        }
        existing_exact.setdefault(import_match_key(stored), origin)
        existing_without_department_id.setdefault(import_match_key(stored, core_fields), origin)

    exact_count = 0
    similar_count = 0
    internal_repeat_count = 0
    samples = []
    file_keys = set()
    for record in records:
        exact = existing_exact.get(import_match_key(record))
        if exact:
            exact_count += 1
            if len(samples) < IMPORT_MATCH_SAMPLE_LIMIT:
                samples.append(import_review_sample(record, exact, "Coincidencia exacta"))
        else:
            similar = existing_without_department_id.get(import_match_key(record, core_fields))
            if similar:
                similar_count += 1
                if len(samples) < IMPORT_MATCH_SAMPLE_LIMIT:
                    samples.append(
                        import_review_sample(
                            record,
                            similar,
                            "Coincide en los demás campos; revisar DEPARTMENT_ID",
                        )
                    )
        key = import_match_key(record)
        if key in file_keys:
            internal_repeat_count += 1
            if len(samples) < IMPORT_MATCH_SAMPLE_LIMIT:
                samples.append(
                    import_review_sample(record, {"filename": "Este mismo archivo"}, "Fila idéntica en el archivo")
                )
        else:
            file_keys.add(key)

    return {
        "period": {"start": start, "end": end},
        "overlapping_batches": overlaps[:8],
        "overlap_count": len(overlaps),
        "overlaps_truncated": len(overlaps) > 8,
        "exact_matches": exact_count,
        "similar_matches": similar_count,
        "file_repeats": internal_repeat_count,
        "match_samples": samples,
        "samples_truncated": exact_count + similar_count + internal_repeat_count > len(samples),
    }


def initialize_database(db_path: Path | str | None = None, source_path: Path | str = SOURCE_PATH) -> None:
    target = Path(db_path) if db_path is not None else DB_PATH
    remote_database = uses_postgres(db_path)
    if not remote_database:
        target.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(db_path)
    create_schema(conn)
    if conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 0:
        source = Path(source_path)
        if source.exists():
            content = source.read_bytes()
            records = import_records_from_xlsx(content)
            batch_id = conn.execute(
                """INSERT INTO import_batches(filename, file_sha256, row_count, imported_by, imported_at)
                   VALUES (?, ?, ?, NULL, ?)""",
                (source.name, hashlib.sha256(content).hexdigest(), len(records), utc_now()),
            ).lastrowid
            for record in records:
                insert_transaction(conn, batch_id, record)
            record_audit(conn, None, "initial_data_loaded", {"filename": source.name, "rows": len(records)})
        elif not remote_database:
            raise FileNotFoundError("No se encontró la planilla inicial: " + str(source))
    if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        departments = [
            row["name"] for row in conn.execute("SELECT name FROM departments ORDER BY name")
        ]
        email = normalize_text(os.environ.get("UNACH_TREASURER_EMAIL")).lower()
        password = os.environ.get("UNACH_TREASURER_PASSWORD", "")
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise RuntimeError(
                "Configura UNACH_TREASURER_EMAIL para crear la cuenta inicial de tesorería."
            )
        if len(password) < 12:
            raise RuntimeError(
                "UNACH_TREASURER_PASSWORD debe tener al menos 12 caracteres."
            )
        conn.execute(
            """INSERT INTO users(email, password_hash, role, department_name, status, created_at, approved_at)
               VALUES (?, ?, 'treasurer', NULL, 'active', ?, ?)""",
            (email, password_hash(password), utc_now(), utc_now()),
        )
    conn.commit()
    conn.close()


def insert_transaction(conn: sqlite3.Connection, batch_id: int, record: dict) -> None:
    conn.execute(
        """INSERT OR IGNORE INTO departments(name, opening_balance, currency)
           VALUES (?, ?, ?)""",
        (record["department_name"], record["opening_balance"], record["currency"]),
    )
    conn.execute(
        """INSERT INTO transactions(
           batch_id, source_row, department_id, department_name, opening_balance, movement_type_number,
           movement_type, movement_date, event_date, amount, description, base_person_id,
           server_id, donor_name, currency, total_by_currency, observations
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            batch_id,
            record["source_row"],
            record.get("department_id", ""),
            record["department_name"],
            record["opening_balance"],
            record["movement_type_number"],
            record["movement_type"],
            record["movement_date"],
            record["event_date"],
            record["amount"],
            record["description"],
            record["base_person_id"],
            record["server_id"],
            record["donor_name"],
            record["currency"],
            record["total_by_currency"],
            record["observations"],
        ),
    )


def period_bounds(conn: sqlite3.Connection, start: str | None, end: str | None) -> tuple[str, str]:
    limits = conn.execute(
        "SELECT MIN(movement_date) AS min_date, MAX(movement_date) AS max_date FROM transactions"
    ).fetchone()
    today = date.today().isoformat()
    start = start or limits["min_date"] or today
    end = end or limits["max_date"] or today
    try:
        start = date.fromisoformat(start).isoformat()
        end = date.fromisoformat(end).isoformat()
    except (ValueError, TypeError) as exc:
        raise ValueError("El período debe usar fechas ISO válidas.") from exc
    if start > end:
        raise ValueError("La fecha inicial no puede ser posterior a la fecha final.")
    return start, end


def parse_calendar_filters(year_value: str | None, month_value: str | None) -> tuple[int | None, list[int] | None]:
    year = None
    if year_value:
        if not re.fullmatch(r"\d{4}", year_value):
            raise ValueError("El año seleccionado no es válido.")
        year = int(year_value)
        if year < 1:
            raise ValueError("El año seleccionado no es válido.")
    months = None
    if month_value:
        try:
            parsed = [int(value) for value in month_value.split(",") if value]
        except ValueError as exc:
            raise ValueError("Los meses seleccionados no son válidos.") from exc
        if any(value < 1 or value > 12 for value in parsed):
            raise ValueError("Los meses deben estar entre enero y diciembre.")
        months = sorted(set(parsed)) or None
    return year, months


def selected_period_intervals(
    start: str,
    end: str,
    year: int | None = None,
    months: list[int] | None = None,
) -> list[tuple[str, str]]:
    first = date.fromisoformat(start)
    last = date.fromisoformat(end)
    if year is not None:
        first = max(first, date(year, 1, 1))
        last = min(last, date(year, 12, 31))
    if first > last:
        return []
    if not months:
        return [(first.isoformat(), last.isoformat())]
    selected = set(months)
    intervals = []
    cursor = first.replace(day=1)
    last_month = last.replace(day=1)
    while cursor <= last_month:
        if cursor.month in selected:
            month_end = date(cursor.year, cursor.month, calendar.monthrange(cursor.year, cursor.month)[1])
            interval_start = max(first, cursor)
            interval_end = min(last, month_end)
            intervals.append((interval_start.isoformat(), interval_end.isoformat()))
        next_year = cursor.year + (1 if cursor.month == 12 else 0)
        next_month = 1 if cursor.month == 12 else cursor.month + 1
        cursor = date(next_year, next_month, 1)
    return intervals


def intervals_sql(column: str, intervals: list[tuple[str, str]]) -> tuple[str, list[str]]:
    if not intervals:
        return "1 = 0", []
    parts = []
    parameters = []
    for interval_start, interval_end in intervals:
        parts.append("(" + column + " >= ? AND " + column + " <= ?)")
        parameters.extend((interval_start, interval_end))
    return "(" + " OR ".join(parts) + ")", parameters


def resolve_summary_department(user: dict, requested: str | None, view: str) -> str | None:
    if user["role"] == "treasurer":
        return requested
    own_department = user["department_name"]
    if view == "department":
        if requested and requested != own_department:
            raise ValueError("No tienes acceso a ese departamento.")
        return own_department
    return None


def get_summary(
    conn: sqlite3.Connection,
    start: str,
    end: str,
    department_name: str | None = None,
    year: int | None = None,
    months: list[int] | None = None,
) -> dict:
    intervals = selected_period_intervals(start, end, year, months)
    period_start = intervals[0][0] if intervals else start
    period_end = intervals[-1][1] if intervals else end
    movement_period, movement_period_params = intervals_sql("t.movement_date", intervals)
    query = """SELECT d.name, d.opening_balance, d.currency,
                    COALESCE(SUM(CASE WHEN t.movement_date < ? THEN t.amount ELSE 0 END), 0) AS prior,
                    COALESCE(SUM(CASE WHEN """ + movement_period + """ AND t.amount > 0
                                      THEN t.amount ELSE 0 END), 0) AS inflow,
                    COALESCE(SUM(CASE WHEN """ + movement_period + """ AND t.amount < 0
                                      THEN -t.amount ELSE 0 END), 0) AS outflow,
                    COALESCE(SUM(CASE WHEN """ + movement_period + """ THEN t.amount ELSE 0 END), 0) AS net,
                    COALESCE(SUM(CASE WHEN """ + movement_period + """ AND t.id IS NOT NULL
                                      THEN 1 ELSE 0 END), 0) AS rows
                 FROM departments d
                 LEFT JOIN transactions t ON t.department_name = d.name
                    AND (t.movement_date < ? OR """ + movement_period + ")"
    query_params = [
        period_start,
        *movement_period_params, *movement_period_params, *movement_period_params, *movement_period_params,
        period_start, *movement_period_params,
    ]
    if department_name is not None:
        query += " WHERE d.name = ?"
        query_params.append(department_name)
    query += " GROUP BY d.name, d.opening_balance, d.currency ORDER BY d.name"
    departments = conn.execute(query, query_params).fetchall()
    if department_name is not None and not departments:
        raise ValueError("Departamento no encontrado.")
    opening_by_department = {row["name"]: int(row["opening_balance"]) for row in departments}
    summaries = [
        {
            "department": row["name"],
            "currency": row["currency"],
            "opening": int(row["opening_balance"]) + int(row["prior"]),
            "inflow": int(row["inflow"]),
            "outflow": int(row["outflow"]),
            "net": int(row["net"]),
            "closing": int(row["opening_balance"]),
            "rows": int(row["rows"]),
        }
        for row in departments
    ]
    totals = {
        "opening": sum(item["opening"] for item in summaries),
        "inflow": sum(item["inflow"] for item in summaries),
        "outflow": sum(item["outflow"] for item in summaries),
        "net": sum(item["net"] for item in summaries),
        "closing": sum(item["closing"] for item in summaries),
        "rows": sum(item["rows"] for item in summaries),
    }
    monthly_sql = """SELECT substr(t.movement_date, 1, 7) AS month,
             COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) AS inflow,
             COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) AS outflow,
             COALESCE(SUM(t.amount), 0) AS net
           FROM transactions t
           WHERE """ + movement_period
    monthly_parameters = list(movement_period_params)
    if department_name is not None:
        monthly_sql += " AND t.department_name = ?"
        monthly_parameters.append(department_name)
    monthly_sql += " GROUP BY substr(t.movement_date, 1, 7) ORDER BY month"
    monthly_query = conn.execute(monthly_sql, monthly_parameters).fetchall()
    monthly_map = {row["month"]: row for row in monthly_query}
    month_cutoffs = {}
    for interval_start, interval_end in intervals:
        month_cursor = date.fromisoformat(interval_start).replace(day=1)
        last_month = date.fromisoformat(interval_end).replace(day=1)
        while month_cursor <= last_month:
            key = month_cursor.strftime("%Y-%m")
            month_end = date(
                month_cursor.year,
                month_cursor.month,
                calendar.monthrange(month_cursor.year, month_cursor.month)[1],
            )
            month_cutoffs[key] = min(date.fromisoformat(interval_end), month_end).isoformat()
            next_year = month_cursor.year + (1 if month_cursor.month == 12 else 0)
            next_month = 1 if month_cursor.month == 12 else month_cursor.month + 1
            month_cursor = date(next_year, next_month, 1)
    non_contiguous = any(
        date.fromisoformat(intervals[index][0])
        > date.fromisoformat(intervals[index - 1][1]) + timedelta(days=1)
        for index in range(1, len(intervals))
    )
    empty_selection = not intervals and (year is not None or bool(months))
    balance_sql = """SELECT department_name, substr(movement_date, 1, 7) AS month,
                      COALESCE(SUM(amount), 0) AS net
                    FROM transactions WHERE movement_date <= ?"""
    balance_parameters: list = [period_end]
    if department_name is not None:
        balance_sql += " AND department_name = ?"
        balance_parameters.append(department_name)
    balance_sql += " GROUP BY department_name, substr(movement_date, 1, 7) ORDER BY month, department_name"
    balance_rows = conn.execute(balance_sql, balance_parameters).fetchall()
    department_month_movements: dict[str, dict[str, int]] = {}
    for row in balance_rows:
        department_month_movements.setdefault(row["month"], {})[row["department_name"]] = int(row["net"])

    running_balances = dict(opening_by_department)
    monthly_closings = {}
    balance_months = sorted(set(department_month_movements) | set(month_cutoffs))
    for key in balance_months:
        for name, amount in department_month_movements.get(key, {}).items():
            if name in running_balances:
                running_balances[name] += amount
        if key in month_cutoffs:
            monthly_closings[key] = sum(running_balances.values())

    summaries_by_department = {item["department"]: item for item in summaries}
    for name, closing in running_balances.items():
        if name in summaries_by_department:
            summaries_by_department[name]["closing"] = closing
    totals["closing"] = sum(item["closing"] for item in summaries)

    monthly = []
    for key in sorted(month_cutoffs):
        row = monthly_map.get(key)
        incoming = int(row["inflow"]) if row else 0
        outgoing = int(row["outflow"]) if row else 0
        net = int(row["net"]) if row else 0
        monthly.append(
            {
                "month": key,
                "inflow": incoming,
                "outflow": outgoing,
                "net": net,
                "closing": monthly_closings.get(key, sum(opening_by_department.values())),
            }
        )
    return {
        "period": {"start": period_start, "end": period_end},
        "totals": totals,
        "departments": summaries,
        "monthly": monthly,
        "scope": department_name or "global",
        "filters": {
            "year": year,
            "months": months or [],
            "nonContiguous": non_contiguous,
            "emptySelection": empty_selection,
        },
    }


def get_transactions(
    conn: sqlite3.Connection,
    start: str,
    end: str,
    department_name: str | None = None,
    search: str | None = None,
    year: int | None = None,
    months: list[int] | None = None,
) -> list[dict]:
    page = get_transactions_page(
        conn, start, end, department_name, search, year, months, page_size=None
    )
    return page["transactions"]


def get_transactions_page(
    conn,
    start: str,
    end: str,
    department_name: str | None = None,
    search: str | None = None,
    year: int | None = None,
    months: list[int] | None = None,
    page: int = 1,
    page_size: int | None = 25,
    cursor: tuple[str, int] | None = None,
) -> dict:
    intervals = selected_period_intervals(start, end, year, months)
    period_end = intervals[-1][1] if intervals else end
    visible_period, period_params = intervals_sql("movement_date", intervals)
    where = ["movement_date <= ?"]
    ledger_params: list = [period_end]
    if department_name is not None:
        where.append("department_name = ?")
        ledger_params.append(department_name)
    fields = [
        "id", "source_row", "department_id", "department_name", "movement_type_number",
        "movement_type", "movement_date", "event_date", "amount", "description",
        "base_person_id", "server_id", "donor_name", "currency", "total_by_currency", "observations",
    ]
    ledger_fields = ", ".join("t." + field for field in fields)
    ledger = """WITH ledger AS (
        SELECT """ + ledger_fields + ",\n               d.opening_balance + SUM(t.amount) OVER (PARTITION BY t.department_name ORDER BY t.movement_date, t.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance\n""" + """        FROM transactions t JOIN departments d ON d.name = t.department_name
        WHERE """ + " AND ".join(where) + "\n    ), selected AS (\n        SELECT * FROM ledger WHERE " + visible_period
    visible_params: list = list(period_params)
    if search:
        terms = re.findall(r"[a-z0-9]+", normalize_search_text(search))
        # Include displayed dates, all identifying columns and both original currency units
        # and running balance. A digits-only alternative preserves lookup by formatted amount.
        date_display = "substr(movement_date, 9, 2) || '/' || substr(movement_date, 6, 2) || '/' || substr(movement_date, 1, 4)"
        event_display = "substr(event_date, 9, 2) || '/' || substr(event_date, 6, 2) || '/' || substr(event_date, 1, 4)"
        searchable = " || ' ' || ".join(
            "COALESCE(CAST(" + field + " AS TEXT), '')" for field in fields[1:]
        ) + " || ' ' || " + date_display + " || ' ' || " + event_display + \
            " || ' ' || CAST(running_balance AS TEXT) || ' ' || CAST(CAST(amount / 100 AS INTEGER) AS TEXT)" + \
            " || ' ' || CAST(CAST(running_balance / 100 AS INTEGER) AS TEXT)"
        normalized_text = (
            "translate(lower(" + searchable + "), "
            + "'áàäâãåéèëêíìïîóòöôõúùüûñç', 'aaaaaaeeeeiiiiooooouuuunc')"
            if isinstance(conn, PostgresConnection)
            else "normalize_search(" + searchable + ")"
        )
        for term in terms:
            ledger += " AND " + normalized_text + " LIKE ?"
            visible_params.append("%" + term + "%")
        digits = re.sub(r"\D", "", search)
        if len(digits) >= 3:
            if isinstance(conn, PostgresConnection):
                only_digits = "regexp_replace(" + searchable + ", '[^0-9]', '', 'g')"
            else:
                only_digits = "digits_only(" + searchable + ")"
            ledger += " AND (" + normalized_text + " LIKE ? OR " + only_digits + " LIKE ?)"
            visible_params.extend(["%" + digits + "%", "%" + digits + "%"])
        elif not terms:
            # Punctuation-only input should never turn into an unbounded full listing.
            ledger += " AND 1 = 0"
    ledger += ")"
    if page_size is not None:
        ledger += ", matched AS (SELECT *, COUNT(*) OVER() AS _match_count FROM selected)"
    select_sql = ledger + (" SELECT * FROM matched" if page_size is not None else " SELECT * FROM selected")
    select_params = [*ledger_params, *visible_params]
    if cursor is not None:
        select_sql += " WHERE (movement_date < ? OR (movement_date = ? AND id < ?))"
        select_params.extend((cursor[0], cursor[0], int(cursor[1])))
    select_sql += " ORDER BY movement_date DESC, id DESC"
    has_more = False
    if page_size is not None:
        page = max(1, int(page))
        select_sql += " LIMIT ?"
        select_params.append(int(page_size) + 1)
        if cursor is None:
            select_sql += " OFFSET ?"
            select_params.append((page - 1) * int(page_size))
    rows = [dict(row) for row in conn.execute(select_sql, select_params).fetchall()]
    total = int(rows[0].pop("_match_count")) if rows and page_size is not None else 0
    if page_size is None:
        total = len(rows)
    if page_size is not None and len(rows) > page_size:
        rows = rows[:page_size]
        has_more = True
    next_cursor = None
    if rows and has_more:
        last = rows[-1]
        next_cursor = {"date": last["movement_date"], "id": int(last["id"])}
    return {
        "transactions": rows,
        "total": total,
        "page": max(1, int(page)),
        "pageSize": page_size,
        "pages": max(1, (total + page_size - 1) // page_size) if page_size else 1,
        "hasMore": has_more,
        "nextCursor": next_cursor,
    }


def format_clp(value: int) -> str:
    value = int(value)
    sign = "-" if value < 0 else ""
    whole, cents = divmod(abs(value), 100)
    formatted = "{:,}".format(whole).replace(",", ".")
    if cents:
        decimal_part = "{:02d}".format(cents).rstrip("0")
        return sign + formatted + "," + decimal_part
    return sign + formatted


def summary_filter_caption(summary: dict) -> str:
    filters = summary.get("filters", {})
    parts = []
    if filters.get("year"):
        parts.append("Año " + str(filters["year"]))
    if filters.get("months"):
        parts.append("Meses: " + ", ".join(MONTH_NAMES_ES[int(month) - 1] for month in filters["months"]))
    return " · ".join(parts)


def export_xlsx(summary: dict, transactions: list[dict] | None) -> bytes:
    Workbook, _, Alignment, Font, PatternFill, get_column_letter = _openpyxl()
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Resumen"
    navy = "174A8B"
    pale = "EAF1FA"
    sheet.append(["Tesorería UNACH", "Balance financiero"])
    period_caption = summary["period"]["start"] + " al " + summary["period"]["end"]
    filter_caption = summary_filter_caption(summary)
    if filter_caption:
        period_caption += " · " + filter_caption
    if summary.get("filters", {}).get("searchApplied"):
        period_caption += " · Detalle: coincidencias de búsqueda"
    sheet.append(["Período", period_caption])
    if summary.get("filters", {}).get("emptySelection"):
        sheet.append(["Selección", "No hay períodos dentro del rango de fechas con la selección de año y meses aplicada."])
    elif summary.get("filters", {}).get("nonContiguous"):
        sheet.append([
            "Criterio de saldo",
            "El movimiento neto suma solo los meses seleccionados; el saldo final incluye todos los movimientos hasta la última fecha incluida.",
        ])
    else:
        sheet.append([])
    sheet.append(["Concepto", "Monto (CLP)"])
    total_names = [
        ("opening", "Saldo inicial"),
        ("inflow", "Ingresos positivos"),
        ("outflow", "Egresos negativos"),
        ("net", "Movimiento neto"),
        ("closing", "Saldo final"),
    ]
    for key, label in total_names:
        sheet.append([label, summary["totals"][key] / 100])
    sheet.append([])
    sheet.append(
        ["Departamento", "Saldo inicial", "Ingresos (+)", "Egresos (-)", "Neto", "Saldo final", "Movimientos"]
    )
    for item in summary["departments"]:
        sheet.append(
            [
                item["department"],
                item["opening"] / 100,
                item["inflow"] / 100,
                item["outflow"] / 100,
                item["net"] / 100,
                item["closing"] / 100,
                item["rows"],
            ]
        )
    for row in sheet.iter_rows():
        for cell in row:
            cell.alignment = Alignment(vertical="center")
            if cell.row in (1, 4, 11):
                cell.fill = PatternFill("solid", fgColor=navy)
                cell.font = Font(bold=True, color="FFFFFF")
            elif cell.row > 11:
                cell.fill = PatternFill("solid", fgColor=pale if cell.row % 2 == 0 else "FFFFFF")
            if cell.data_type == "n":
                cell.number_format = '#,##0.00;[Red](#,##0.00);-'
    sheet.column_dimensions["A"].width = 40
    for col in range(2, 8):
        sheet.column_dimensions[get_column_letter(col)].width = 20
    sheet.freeze_panes = "A12"
    sheet.auto_filter.ref = "A11:G{}".format(sheet.max_row)
    if transactions is not None:
        detail = workbook.create_sheet("Movimientos")
        headers = [
            "Fecha Movimiento",
            "Fecha del Evento",
            "Departamento",
            "Tipo",
            "Descripción",
            "Aportante",
            "Observaciones",
            "Importe firmado",
            "Saldo corrido",
        ]
        detail.append(headers)
        for row in transactions:
            detail.append(
                [
                    row["movement_date"],
                    row["event_date"],
                    row["department_name"],
                    row["movement_type"],
                    row["description"],
                    row["donor_name"],
                    row["observations"],
                    row["amount"] / 100,
                    row["running_balance"] / 100,
                ]
            )
        for cell in detail[1]:
            cell.fill = PatternFill("solid", fgColor=navy)
            cell.font = Font(bold=True, color="FFFFFF")
        for row in detail.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(vertical="top", wrap_text=True)
                if cell.column >= 8:
                    cell.number_format = '#,##0.00;[Red](#,##0.00);-'
        for column, width in {
            "A": 16,
            "B": 16,
            "C": 32,
            "D": 27,
            "E": 56,
            "F": 32,
            "G": 36,
            "H": 20,
            "I": 20,
        }.items():
            detail.column_dimensions[column].width = width
        detail.freeze_panes = "A2"
        detail.auto_filter.ref = detail.dimensions
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


def export_pdf(summary: dict, transactions: list[dict] | None) -> bytes:
    (colors, TA_LEFT, TA_RIGHT, A4, landscape, ParagraphStyle,
     getSampleStyleSheet, mm, LongTable, Paragraph, SimpleDocTemplate,
     Spacer, Table, TableStyle) = _reportlab()
    output = io.BytesIO()
    page_size = landscape(A4)
    doc = SimpleDocTemplate(
        output,
        pagesize=page_size,
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=18 * mm,
        bottomMargin=15 * mm,
        title="Informe de Tesorería UNACH",
        author="Tesorería UNACH",
    )
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="ReportTitle",
            parent=styles["Title"],
            fontName="Helvetica-Bold",
            fontSize=20,
            leading=24,
            textColor=colors.HexColor("#173D70"),
            alignment=TA_LEFT,
            spaceAfter=4,
        )
    )
    styles.add(
        ParagraphStyle(
            name="ReportMeta",
            parent=styles["Normal"],
            fontSize=8,
            leading=10,
            textColor=colors.HexColor("#64748B"),
        )
    )
    styles.add(
        ParagraphStyle(
            name="Cell",
            parent=styles["Normal"],
            fontName="Helvetica",
            fontSize=6.5,
            leading=8,
            wordWrap="CJK",
        )
    )
    styles.add(
        ParagraphStyle(name="CellRight", parent=styles["Cell"], alignment=TA_RIGHT)
    )
    period_caption = "{} al {}".format(
        date.fromisoformat(summary["period"]["start"]).strftime("%d/%m/%Y"),
        date.fromisoformat(summary["period"]["end"]).strftime("%d/%m/%Y"),
    )
    filter_caption = summary_filter_caption(summary)
    if filter_caption:
        period_caption += " | " + filter_caption
    if summary.get("filters", {}).get("searchApplied"):
        period_caption += " | detalle: coincidencias de búsqueda"
    story = [
        Paragraph("Tesorería UNACH", styles["ReportTitle"]),
        Paragraph(
            "{} | {}".format(
                "Balance general" if summary["scope"] == "global" else "Departamento: " + html.escape(summary["scope"]),
                html.escape(period_caption),
            ),
            styles["ReportMeta"],
        ),
    ]
    if summary.get("filters", {}).get("emptySelection"):
        story.append(Paragraph(
            "No hay períodos dentro del rango de fechas con la selección de año y meses aplicada.",
            styles["ReportMeta"],
        ))
    elif summary.get("filters", {}).get("nonContiguous"):
        story.append(Paragraph(
            "El movimiento neto suma solo los meses seleccionados; el saldo final incluye todos los movimientos hasta la última fecha incluida.",
            styles["ReportMeta"],
        ))
    if summary.get("filters", {}).get("searchApplied"):
        story.append(Paragraph(
            "El resumen cubre el período completo; el detalle incluye solo las coincidencias de búsqueda.",
            styles["ReportMeta"],
        ))
    story.append(Spacer(1, 7 * mm))
    total = summary["totals"]
    cards = [
        ["Saldo inicial", "Ingresos (+)", "Egresos (-)", "Movimiento neto", "Saldo final"],
        [
            "$ " + format_clp(total["opening"]),
            "$ " + format_clp(total["inflow"]),
            "$ " + format_clp(total["outflow"]),
            "$ " + format_clp(total["net"]),
            "$ " + format_clp(total["closing"]),
        ],
    ]
    card_table = Table(cards, colWidths=[(page_size[0] - 24 * mm) / 5] * 5)
    card_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF1FA")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#173D70")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (-1, 1), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D6E0ED")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    story.extend([card_table, Spacer(1, 7 * mm)])
    if transactions is None:
        story.append(Paragraph("Balance por departamento", styles["Heading2"]))
        rows = [[
            "Departamento",
            "Saldo inicial",
            "Ingresos (+)",
            "Egresos (-)",
            "Neto",
            "Saldo final",
            "Mov.",
        ]]
        for item in summary["departments"]:
            rows.append(
                [
                    Paragraph(html.escape(item["department"]), styles["Cell"]),
                    "$ " + format_clp(item["opening"]),
                    "$ " + format_clp(item["inflow"]),
                    "$ " + format_clp(item["outflow"]),
                    "$ " + format_clp(item["net"]),
                    "$ " + format_clp(item["closing"]),
                    str(item["rows"]),
                ]
            )
        widths = [57 * mm, 27 * mm, 27 * mm, 27 * mm, 27 * mm, 27 * mm, 14 * mm]
        table = LongTable(rows, colWidths=widths, repeatRows=1, hAlign="LEFT")
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#173D70")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 7),
                    ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FC")]),
                    ("LINEBELOW", (0, 0), (-1, 0), 0.8, colors.HexColor("#173D70")),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                ]
            )
        )
        story.append(table)
    else:
        story.append(Paragraph("Detalle de movimientos", styles["Heading2"]))
        rows = [[
            "F. movimiento",
            "F. evento",
            "Departamento",
            "Tipo",
            "Glosa / observaciones",
            "Aportante",
            "Importe",
            "Saldo",
        ]]
        for item in transactions:
            description = html.escape(item["description"] or "Sin glosa")
            if item["observations"]:
                description += "<br/><font color='#64748B'><b>Obs.:</b> " + html.escape(item["observations"]) + "</font>"
            rows.append(
                [
                    date.fromisoformat(item["movement_date"]).strftime("%d/%m/%Y"),
                    date.fromisoformat(item["event_date"]).strftime("%d/%m/%Y"),
                    Paragraph(html.escape(item["department_name"]), styles["Cell"]),
                    Paragraph(html.escape(item["movement_type"]), styles["Cell"]),
                    Paragraph(description, styles["Cell"]),
                    Paragraph(html.escape(item["donor_name"]), styles["Cell"]),
                    Paragraph("$ " + format_clp(item["amount"]), styles["CellRight"]),
                    Paragraph("$ " + format_clp(item["running_balance"]), styles["CellRight"]),
                ]
            )
        widths = [22 * mm, 22 * mm, 35 * mm, 33 * mm, 66 * mm, 40 * mm, 26 * mm, 26 * mm]
        table = LongTable(rows, colWidths=widths, repeatRows=1, hAlign="LEFT")
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#173D70")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 6.5),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("ALIGN", (6, 1), (-1, -1), "RIGHT"),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FC")]),
                    ("LINEBELOW", (0, 0), (-1, 0), 0.8, colors.HexColor("#173D70")),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                ]
            )
        )
        story.append(table)

    def add_footer(canvas, document):
        canvas.saveState()
        width, _ = page_size
        canvas.setStrokeColor(colors.HexColor("#D8E1EC"))
        canvas.line(12 * mm, 11 * mm, width - 12 * mm, 11 * mm)
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(colors.HexColor("#64748B"))
        canvas.drawString(12 * mm, 7 * mm, "Tesorería UNACH | Documento interno")
        canvas.drawRightString(width - 12 * mm, 7 * mm, "Página {}".format(document.page))
        canvas.restoreState()

    doc.build(story, onFirstPage=add_footer, onLaterPages=add_footer)
    return output.getvalue()


class TreasuryHandler(BaseHTTPRequestHandler):
    server_version = "TesoreríaUNACH/1.0"

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _observability_headers(self):
        request_id = getattr(self, "_request_id", None)
        if request_id:
            self.send_header("X-Request-ID", request_id)
        started = getattr(self, "_request_started", None)
        conn = getattr(self, "_active_connection", None)
        if started is not None:
            connect_ms = float(getattr(conn, "connect_duration_ms", 0.0))
            query_ms = float(getattr(conn, "query_duration_ms", 0.0))
            query_count = int(getattr(conn, "query_count", 0))
            total_ms = (time.perf_counter() - started) * 1000
            self.send_header(
                "Server-Timing",
                "connect;dur={:.1f}, db;dur={:.1f};desc=\"{} SQL\", app;dur={:.1f}".format(
                    connect_ms, query_ms, query_count, total_ms
                ),
            )

    def send_json(self, status: int, payload: dict, cookie: str | None = None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._observability_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
        )
        self.send_header("Content-Length", str(len(data)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def send_bytes(self, status: int, body: bytes, content_type: str, filename: str):
        safe = re.sub(r"[^A-Za-z0-9._-]+", "-", filename)
        self.send_response(status)
        self._observability_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Disposition", 'attachment; filename="{}"'.format(safe))
        self.end_headers()
        self.wfile.write(body)

    def parse_body(self, maximum: int = MAX_UPLOAD_BYTES) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > maximum:
            raise ValueError("La solicitud supera el límite permitido.")
        return self.rfile.read(length)

    def parse_json_body(self) -> dict:
        body = self.parse_body(1024 * 1024)
        try:
            return json.loads(body.decode("utf-8")) if body else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("La solicitud no contiene JSON válido.") from exc

    def check_origin(self) -> bool:
        origin = self.headers.get("Origin")
        host = self.headers.get("Host")
        if not origin or not host:
            return True
        parsed = urllib.parse.urlparse(origin)
        return parsed.netloc.lower() == host.lower() and parsed.scheme in ("http", "https")

    def current_user(self, conn: sqlite3.Connection) -> dict | None:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie["unach_session"].value
        except (KeyError, CookieError):
            return None
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        row = conn.execute(
            """SELECT u.id, u.email, u.role, u.department_name, u.status, s.expires_at
               FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?""",
            (token_hash,),
        ).fetchone()
        if not row or row["expires_at"] < int(time.time()) or row["status"] != "active":
            if row:
                conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            return None
        return dict(row)

    def require_user(self, conn: sqlite3.Connection) -> dict | None:
        user = self.current_user(conn)
        if not user:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Inicia sesión para continuar."})
            return None
        return user

    def require_treasurer(self, conn: sqlite3.Connection) -> dict | None:
        user = self.require_user(conn)
        if user and user["role"] != "treasurer":
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "Esta acción requiere acceso de tesorería."})
            return None
        return user

    def do_GET(self):
        self._request_started = time.perf_counter()
        self._request_id = uuid.uuid4().hex
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.serve_static(parsed.path)
            return
        conn = connect()
        self._active_connection = conn
        try:
            query = urllib.parse.parse_qs(parsed.query)
            if parsed.path == "/api/departments":
                names = [r["name"] for r in conn.execute("SELECT name FROM departments ORDER BY name")]
                self.send_json(200, {"departments": names})
            elif parsed.path == "/api/me":
                user = self.current_user(conn)
                if not user:
                    self.send_json(200, {"user": None})
                    return
                self.send_json(200, session_metadata(conn, user))
            elif parsed.path == "/api/summary":
                user = self.require_user(conn)
                if not user:
                    return
                start, end = period_bounds(conn, (query.get("start") or [None])[0], (query.get("end") or [None])[0])
                year, months = parse_calendar_filters(
                    (query.get("year") or [None])[0],
                    (query.get("months") or [None])[0],
                )
                requested = (query.get("department") or [None])[0]
                view = (query.get("view") or ["global"])[0]
                scope = resolve_summary_department(user, requested, view)
                report = get_summary(conn, start, end, scope, year, months)
                record_audit(conn, user["id"], "report_viewed", {
                    "scope": scope or "global", "start": start, "end": end,
                    "year": year, "months": months or [],
                })
                conn.commit()
                self.send_json(200, report)
            elif parsed.path == "/api/transactions":
                user = self.require_user(conn)
                if not user:
                    return
                start, end = period_bounds(conn, (query.get("start") or [None])[0], (query.get("end") or [None])[0])
                requested = (query.get("department") or [None])[0]
                if user["role"] == "department":
                    if requested and requested != user["department_name"]:
                        self.send_json(403, {"error": "No tienes acceso a ese departamento."})
                        return
                    scope = user["department_name"]
                else:
                    scope = requested
                search = ((query.get("q") or [""])[0] or "").strip()[:120]
                year, months = parse_calendar_filters(
                    (query.get("year") or [None])[0],
                    (query.get("months") or [None])[0],
                )
                page = max(1, int((query.get("page") or ["1"])[0]))
                page_size = 25
                cursor = None
                if (query.get("cursor_date") or [""])[0] or (query.get("cursor_id") or [""])[0]:
                    cursor_date = (query.get("cursor_date") or [""])[0]
                    cursor_id_raw = (query.get("cursor_id") or [""])[0]
                    try:
                        date.fromisoformat(cursor_date)
                        cursor_id = int(cursor_id_raw)
                        if cursor_id <= 0:
                            raise ValueError
                    except (TypeError, ValueError) as exc:
                        raise ValueError("El cursor de movimientos no es válido.") from exc
                    cursor = (cursor_date, cursor_id)
                if not search:
                    record_audit(conn, user["id"], "transactions_viewed", {
                        "scope": scope or "all_departments", "start": start, "end": end,
                        "year": year, "months": months or [],
                    })
                    conn.commit()
                page_data = get_transactions_page(
                    conn, start, end, scope, search or None, year, months,
                    page=page, page_size=page_size, cursor=cursor,
                )
                self.send_json(
                    200,
                    {
                        **page_data,
                        "scope": scope or "all_departments",
                    },
                )
            elif parsed.path == "/api/admin/users":
                user = self.require_treasurer(conn)
                if not user:
                    return
                rows = conn.execute(
                    """SELECT u.id, u.email, u.role, u.department_name, u.status, u.created_at,
                              u.approved_at
                       FROM users u ORDER BY
                         CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                         u.created_at DESC"""
                ).fetchall()
                self.send_json(200, {"users": [dict(row) for row in rows]})
            elif parsed.path == "/api/admin/audit":
                user = self.require_treasurer(conn)
                if not user:
                    return
                start = ((query.get("start") or [""])[0] or "").strip()
                end = ((query.get("end") or [""])[0] or "").strip()
                department = ((query.get("department") or [""])[0] or "").strip()
                search = ((query.get("q") or [""])[0] or "").strip()[:120]
                where, params = [], []
                if start:
                    start_date = date.fromisoformat(start)
                    start_utc = datetime.combine(
                        start_date, datetime.min.time(), LOCAL_TIMEZONE
                    ).astimezone(timezone.utc).isoformat()
                    where.append("a.created_at >= ?")
                    params.append(start_utc)
                if end:
                    end_date = date.fromisoformat(end) + timedelta(days=1)
                    end_utc = datetime.combine(
                        end_date, datetime.min.time(), LOCAL_TIMEZONE
                    ).astimezone(timezone.utc).isoformat()
                    where.append("a.created_at < ?")
                    params.append(end_utc)
                if department:
                    where.append("(u.department_name = ? OR a.detail LIKE ?)")
                    params.extend((department, "%" + department + "%"))
                if search:
                    searchable = "a.created_at || ' ' || a.event_type || ' ' || a.detail || ' ' || COALESCE(u.email, '')"
                    normalized = (
                        "translate(lower(" + searchable + "), "
                        + "'áàäâãåéèëêíìïîóòöôõúùüûñç', 'aaaaaaeeeeiiiiooooouuuunc')"
                        if isinstance(conn, PostgresConnection)
                        else "normalize_search(" + searchable + ")"
                    )
                    terms = re.findall(r"[a-z0-9]+", normalize_search_text(search))
                    for term in terms:
                        where.append(normalized + " LIKE ?")
                        params.append("%" + term + "%")
                    digit_search = re.sub(r"\D", "", search)
                    if len(digit_search) >= 3:
                        digits = (
                            "regexp_replace(" + searchable + ", '[^0-9]', '', 'g')"
                            if isinstance(conn, PostgresConnection)
                            else "digits_only(" + searchable + ")"
                        )
                        where.append("(" + normalized + " LIKE ? OR " + digits + " LIKE ?)")
                        params.extend(("%" + digit_search + "%", "%" + digit_search + "%"))
                    elif not terms:
                        where.append("1 = 0")
                base_sql = """ FROM audit_log a LEFT JOIN users u ON u.id = a.user_id"""
                if where:
                    base_sql += " WHERE " + " AND ".join(where)
                total = int(conn.execute("SELECT COUNT(*)" + base_sql, params).fetchone()[0])
                cursor_raw = ((query.get("cursor_id") or [""])[0] or "").strip()
                cursor_id = None
                if cursor_raw:
                    try:
                        cursor_id = int(cursor_raw)
                        if cursor_id < 1:
                            raise ValueError
                    except ValueError as exc:
                        raise ValueError("El cursor de actividad no es válido.") from exc
                select_sql = "SELECT a.id, a.event_type, a.detail, a.created_at, u.email" + base_sql
                select_params = list(params)
                if cursor_id is not None:
                    select_sql += (" AND " if where else " WHERE ") + "a.id < ?"
                    select_params.append(cursor_id)
                select_sql += " ORDER BY a.id DESC LIMIT 51"
                rows = [dict(row) for row in conn.execute(select_sql, select_params).fetchall()]
                has_more = len(rows) > 50
                if has_more:
                    rows = rows[:50]
                next_cursor = rows[-1]["id"] if has_more and rows else None
                self.send_json(
                    200,
                    {"events": rows, "total": total, "hasMore": has_more, "nextCursor": next_cursor},
                )
            elif parsed.path == "/api/export":
                self.handle_export(conn, query)
            else:
                self.send_json(404, {"error": "Ruta no encontrada."})
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "Ocurrió un error al procesar la solicitud."})
        finally:
            conn.close()

    def do_POST(self):
        self._request_started = time.perf_counter()
        self._request_id = uuid.uuid4().hex
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_json(404, {"error": "Ruta no encontrada."})
            return
        if not self.check_origin():
            self.send_json(403, {"error": "Origen de solicitud no permitido."})
            return
        conn = connect()
        self._active_connection = conn
        try:
            if parsed.path == "/api/login":
                self.handle_login(conn)
            elif parsed.path == "/api/register":
                self.handle_register(conn)
            elif parsed.path == "/api/logout":
                self.handle_logout(conn)
            elif parsed.path == "/api/admin/users/status":
                self.handle_user_status(conn)
            elif parsed.path == "/api/admin/import/preview":
                self.handle_import_preview(conn)
            elif parsed.path == "/api/admin/import/commit":
                self.handle_import_commit(conn)
            else:
                self.send_json(404, {"error": "Ruta no encontrada."})
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "Ocurrió un error al procesar la solicitud."})
        finally:
            conn.close()

    def handle_login(self, conn: sqlite3.Connection):
        payload = self.parse_json_body()
        email = normalize_text(payload.get("email")).lower()
        password = str(payload.get("password") or "")
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            record_audit(conn, row["id"] if row else None, "login_failed", {"email": email})
            conn.commit()
            self.send_json(401, {"error": "Correo o contraseña incorrectos."})
            return
        if row["status"] != "active":
            event = "login_pending" if row["status"] == "pending" else "login_inactive"
            record_audit(conn, row["id"], event, {})
            conn.commit()
            message = (
                "Tu solicitud espera aprobación del tesorero."
                if row["status"] == "pending"
                else "Esta cuenta está desactivada. Contacta al tesorero."
            )
            self.send_json(403, {"error": message})
            return
        token = secrets.token_urlsafe(36)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        expiry = int(time.time()) + SESSION_SECONDS
        conn.execute(
            "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (token_hash, row["id"], expiry),
        )
        record_audit(conn, row["id"], "login_success", {})
        conn.commit()
        secure_cookie = "; Secure" if os.environ.get("VERCEL") or self.headers.get("X-Forwarded-Proto") == "https" else ""
        cookie = "unach_session={}; Path=/; Max-Age={}; HttpOnly; SameSite=Strict{}".format(
            token, SESSION_SECONDS, secure_cookie
        )
        self.send_json(
            200,
            session_metadata(conn, {
                "id": row["id"],
                "email": row["email"],
                "role": row["role"],
                "department_name": row["department_name"],
                "status": row["status"],
            }),
            cookie=cookie,
        )

    def handle_register(self, conn: sqlite3.Connection):
        payload = self.parse_json_body()
        email = normalize_text(payload.get("email")).lower()
        password = str(payload.get("password") or "")
        department = normalize_text(payload.get("department"))
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ValueError("Escribe un correo válido.")
        if len(password) < 10:
            raise ValueError("La contraseña debe tener al menos 10 caracteres.")
        if not conn.execute("SELECT 1 FROM departments WHERE name = ?", (department,)).fetchone():
            raise ValueError("Selecciona un departamento de la lista.")
        try:
            cursor = conn.execute(
                """INSERT INTO users(email, password_hash, role, department_name, status, created_at)
                   VALUES (?, ?, 'department', ?, 'pending', ?)""",
                (email, password_hash(password), department, utc_now()),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError("Ya existe una solicitud para ese correo.") from exc
        record_audit(conn, cursor.lastrowid, "registration_submitted", {"department": department})
        conn.commit()
        self.send_json(
            201,
            {"message": "Solicitud enviada. El tesorero debe aprobarla antes del primer ingreso."},
        )

    def handle_logout(self, conn: sqlite3.Connection):
        user = self.current_user(conn)
        if user:
            cookie = SimpleCookie()
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie["unach_session"].value
            conn.execute(
                "DELETE FROM sessions WHERE token_hash = ?",
                (hashlib.sha256(token.encode("utf-8")).hexdigest(),),
            )
            record_audit(conn, user["id"], "logout", {})
            conn.commit()
        self.send_json(
            200,
            {"message": "Sesión cerrada."},
            cookie="unach_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict{}".format(
                "; Secure" if os.environ.get("VERCEL") or self.headers.get("X-Forwarded-Proto") == "https" else ""
            ),
        )

    def handle_user_status(self, conn: sqlite3.Connection):
        actor = self.require_treasurer(conn)
        if not actor:
            return
        payload = self.parse_json_body()
        user_id = int(payload.get("user_id", 0))
        status = normalize_text(payload.get("status"))
        if status not in ("active", "inactive"):
            raise ValueError("El nuevo estado debe ser activo o desactivado.")
        target = conn.execute(
            "SELECT id, email, role, status, department_name FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not target:
            raise ValueError("No se encontró el usuario.")
        if target["role"] == "treasurer" and target["id"] == actor["id"] and status == "inactive":
            raise ValueError("No puedes desactivar tu propia cuenta de tesorero.")
        approved_at = utc_now() if status == "active" else None
        conn.execute(
            "UPDATE users SET status = ?, approved_at = COALESCE(?, approved_at) WHERE id = ?",
            (status, approved_at, user_id),
        )
        if status == "inactive":
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        event = "user_approved" if status == "active" else "user_deactivated"
        record_audit(
            conn,
            actor["id"],
            event,
            {
                "user_id": user_id,
                "email": target["email"],
                "department": target["department_name"],
            },
        )
        conn.commit()
        self.send_json(200, {"message": "Estado actualizado."})

    def parse_uploaded_xlsx(self) -> tuple[str, bytes]:
        content_type = self.headers.get("Content-Type", "")
        body = self.parse_body(MAX_UPLOAD_BYTES)
        message = BytesParser(policy=policy.default).parsebytes(
            b"Content-Type: "
            + content_type.encode("ascii", "ignore")
            + b"\r\nMIME-Version: 1.0\r\n\r\n"
            + body
        )
        for part in message.iter_parts():
            if part.get_content_disposition() == "form-data" and part.get_filename():
                filename = Path(part.get_filename()).name
                content = part.get_payload(decode=True) or b""
                if not filename.lower().endswith(".xlsx"):
                    raise ValueError("La carga acepta archivos .xlsx.")
                if len(content) > MAX_UPLOAD_BYTES:
                    limit_mb = max(1, MAX_UPLOAD_BYTES // (1024 * 1024))
                    raise ValueError("El archivo supera el límite de {} MB.".format(limit_mb))
                return filename, content
        raise ValueError("Selecciona un archivo .xlsx.")

    def handle_import_preview(self, conn: sqlite3.Connection):
        actor = self.require_treasurer(conn)
        if not actor:
            return
        expired_before = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        conn.execute("DELETE FROM import_previews WHERE created_at < ?", (expired_before,))
        filename, content = self.parse_uploaded_xlsx()
        records = import_records_from_xlsx(content)
        known_departments = {
            row["name"] for row in conn.execute("SELECT name FROM departments").fetchall()
        }
        unknown = sorted({r["department_name"] for r in records} - known_departments)
        file_hash = hashlib.sha256(content).hexdigest()
        previous = conn.execute(
            "SELECT COUNT(*) FROM import_batches WHERE file_sha256 = ?", (file_hash,)
        ).fetchone()[0]
        analysis = analyze_import(conn, records)
        token = secrets.token_urlsafe(24)
        conn.execute(
            """INSERT INTO import_previews(token, filename, file_sha256, row_count, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (token, filename, file_hash, len(records), actor["id"], utc_now()),
        )
        staging_rows = [
            (token, json.dumps(record, ensure_ascii=False)) for record in records
        ]
        for start in range(0, len(staging_rows), 1000):
            conn.executemany(
                "INSERT INTO import_staging(preview_token, record_json) VALUES (?, ?)",
                staging_rows[start : start + 1000],
            )
        record_audit(
            conn,
            actor["id"],
            "import_previewed",
            {
                "filename": filename,
                "rows": len(records),
                "same_file_warning": bool(previous),
                "period": analysis["period"],
                "overlap_count": analysis["overlap_count"],
                "new_departments": unknown,
                "exact_matches": analysis["exact_matches"],
                "similar_matches": analysis["similar_matches"],
                "file_repeats": analysis["file_repeats"],
            },
        )
        conn.commit()
        self.send_json(
            200,
            {
                "preview_token": token,
                "filename": filename,
                "rows": len(records),
                "same_file_warning": bool(previous),
                "message": "No se eliminarán filas automáticamente; revisa los avisos antes de incorporar.",
                "new_departments": unknown,
                **analysis,
            },
        )

    def handle_import_commit(self, conn: sqlite3.Connection):
        if not isinstance(conn, PostgresConnection):
            # SQLite's reserved write lock serializes retries before they inspect staging.
            conn.execute("BEGIN IMMEDIATE")
        actor = self.require_treasurer(conn)
        if not actor:
            return
        payload = self.parse_json_body()
        token = normalize_text(payload.get("preview_token"))
        lock_clause = " FOR UPDATE" if isinstance(conn, PostgresConnection) else ""
        preview = conn.execute(
            "SELECT * FROM import_previews WHERE token = ? AND created_by = ?" + lock_clause,
            (token, actor["id"]),
        ).fetchone()
        if not preview:
            raise ValueError("La vista previa expiró o no existe.")
        expired_before = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        if preview["created_at"] < expired_before:
            conn.execute("DELETE FROM import_previews WHERE token = ?", (token,))
            conn.commit()
            raise ValueError("La vista previa expiró. Vuelve a validar el archivo.")
        if preview["status"] == "completed":
            conn.commit()
            self.send_json(
                200,
                {
                    "message": "Esta importación ya fue incorporada.",
                    "rows": int(preview["row_count"]),
                    "batch_id": preview["result_batch_id"],
                    "already_completed": True,
                },
            )
            return
        if preview["status"] != "ready":
            raise ValueError("La vista previa ya está en proceso. Revisa el resultado antes de reintentar.")
        existing = conn.execute(
            "SELECT 1 FROM import_batches WHERE file_sha256 = ? LIMIT 1",
            (preview["file_sha256"],),
        ).fetchone()
        staged = conn.execute(
            "SELECT record_json FROM import_staging WHERE preview_token = ? ORDER BY id",
            (token,),
        ).fetchall()
        if len(staged) != preview["row_count"]:
            raise ValueError("La vista previa está incompleta; vuelve a cargar el archivo.")
        records = [json.loads(row["record_json"]) for row in staged]
        analysis = analyze_import(conn, records)
        known_departments = {
            row["name"] for row in conn.execute("SELECT name FROM departments").fetchall()
        }
        new_departments = sorted({record["department_name"] for record in records} - known_departments)
        analysis["new_departments"] = new_departments
        required = {
            "same_file": bool(existing),
            "overlap": analysis["overlap_count"] > 0,
            "new_departments": bool(new_departments),
            "matches": bool(
                analysis["exact_matches"]
                or analysis["similar_matches"]
                or analysis["file_repeats"]
            ),
        }
        confirmed = {
            "same_file": bool(payload.get("confirm_same_file")),
            "overlap": bool(payload.get("confirm_overlap")),
            "new_departments": bool(payload.get("confirm_new_departments")),
            "matches": bool(payload.get("confirm_matches")),
        }
        if any(required[key] and not confirmed[key] for key in required):
            needs = [key for key in required if required[key] and not confirmed[key]]
            self.send_json(
                409,
                {
                    "error": "Revisa el período y las coincidencias detectadas antes de incorporar.",
                    "requires_confirmation": needs,
                    "analysis": analysis,
                    "same_file_warning": bool(existing),
                },
            )
            return
        batch_id = conn.execute(
            """INSERT INTO import_batches(filename, file_sha256, row_count, imported_by, imported_at)
               VALUES (?, ?, ?, ?, ?)""",
            (
                preview["filename"],
                preview["file_sha256"],
                preview["row_count"],
                actor["id"],
                utc_now(),
            ),
        ).lastrowid
        known_departments = set()
        for record in records:
            department = record["department_name"]
            if department not in known_departments:
                conn.execute(
                    """INSERT OR IGNORE INTO departments(name, opening_balance, currency)
                       VALUES (?, ?, ?)""",
                    (department, record["opening_balance"], record["currency"]),
                )
                known_departments.add(department)
        transaction_rows = [
            (
                batch_id,
                record["source_row"],
                record.get("department_id", ""),
                record["department_name"],
                record["opening_balance"],
                record["movement_type_number"],
                record["movement_type"],
                record["movement_date"],
                record["event_date"],
                record["amount"],
                record["description"],
                record["base_person_id"],
                record["server_id"],
                record["donor_name"],
                record["currency"],
                record["total_by_currency"],
                record["observations"],
            )
            for record in records
        ]
        transaction_sql = """INSERT INTO transactions(
           batch_id, source_row, department_id, department_name, opening_balance, movement_type_number,
           movement_type, movement_date, event_date, amount, description, base_person_id,
           server_id, donor_name, currency, total_by_currency, observations
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""
        for start in range(0, len(transaction_rows), 1000):
            conn.executemany(transaction_sql, transaction_rows[start : start + 1000])
        conn.execute("DELETE FROM import_staging WHERE preview_token = ?", (token,))
        consumed = conn.execute(
            """UPDATE import_previews SET status = 'completed', result_batch_id = ?, completed_at = ?
               WHERE token = ? AND created_by = ? AND status = 'ready'""",
            (batch_id, utc_now(), token, actor["id"]),
        )
        if consumed.rowcount != 1:
            raise ValueError("La vista previa ya fue procesada. Consulta su resultado antes de reintentar.")
        record_audit(
            conn,
            actor["id"],
            "import_completed",
            {
                "filename": preview["filename"],
                "rows": preview["row_count"],
                "batch_id": batch_id,
                "period": analysis["period"],
                "overlap_count": analysis["overlap_count"],
                "exact_matches": analysis["exact_matches"],
                "similar_matches": analysis["similar_matches"],
                "file_repeats": analysis["file_repeats"],
            },
        )
        conn.commit()
        self.send_json(
            201,
            {
                "message": "Importación completada.",
                "rows": preview["row_count"],
                "batch_id": batch_id,
                "warnings": analysis,
            },
        )

    def handle_export(self, conn: sqlite3.Connection, query: dict):
        user = self.require_user(conn)
        if not user:
            return
        start, end = period_bounds(conn, (query.get("start") or [None])[0], (query.get("end") or [None])[0])
        year, months = parse_calendar_filters(
            (query.get("year") or [None])[0],
            (query.get("months") or [None])[0],
        )
        requested = (query.get("department") or [None])[0]
        view = (query.get("view") or ["global"])[0]
        format_name = (query.get("format") or ["xlsx"])[0].lower()
        if format_name not in ("xlsx", "pdf"):
            self.send_json(400, {"error": "Formato no compatible."})
            return
        if user["role"] == "department":
            scope = user["department_name"] if view == "department" else None
            if requested and requested != user["department_name"] and view == "department":
                self.send_json(403, {"error": "No tienes acceso a ese departamento."})
                return
        else:
            scope = requested
        summary = get_summary(conn, start, end, scope, year, months)
        include_detail = view == "department" or (
            user["role"] == "treasurer" and view == "all_detail"
        )
        search = ((query.get("q") or [""])[0] or "").strip()[:120]
        if search and not include_detail:
            raise ValueError("La búsqueda solo se puede aplicar al detalle de movimientos.")
        if search:
            summary["filters"]["searchApplied"] = True
        rows = get_transactions(conn, start, end, scope, search or None, year, months) if include_detail else None
        event = "export_pdf" if format_name == "pdf" else "export_xlsx"
        record_audit(
            conn,
            user["id"],
            event,
            {
                "scope": scope or "global", "view": view, "start": start, "end": end,
                "year": year, "months": months or [],
                "detail_filtered": bool(search),
            },
        )
        conn.commit()
        label = scope or ("todos-los-departamentos" if include_detail else "general")
        filename = "unach-{}-{}-{}.{}".format(label, start, end, format_name)
        if format_name == "xlsx":
            body = export_xlsx(summary, rows)
            self.send_bytes(
                200,
                body,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                filename,
            )
        else:
            body = export_pdf(summary, rows)
            self.send_bytes(200, body, "application/pdf", filename)

    def serve_static(self, requested: str):
        if requested == "/":
            requested = "/index.html"
        relative = urllib.parse.unquote(requested).lstrip("/")
        target = (PUBLIC_DIR / relative).resolve()
        if not target.is_relative_to(PUBLIC_DIR.resolve()) or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content = target.read_bytes()
        content_type, _ = mimetypes.guess_type(str(target))
        if target.suffix == ".webmanifest":
            content_type = "application/manifest+json"
        self.send_response(200)
        self.send_header("Content-Type", (content_type or "application/octet-stream") + "; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
        )
        if target.name == "sw.js":
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)


def main():
    if sys.argv[1:] == ["--migrate"]:
        conn = connect()
        try:
            create_schema(conn)
            print("Esquema de Tesorería UNACH actualizado.")
        finally:
            conn.close()
        return
    initialize_database()
    server = ThreadingHTTPServer((HOST, PORT), TreasuryHandler)
    print("Tesorería UNACH disponible en http://{}:{}".format(HOST, PORT))
    print("Base local: {}".format(DB_PATH))
    print("Presiona Ctrl+C para detener el servidor.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
