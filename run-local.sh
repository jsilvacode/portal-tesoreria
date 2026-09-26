#!/bin/sh
set -e

# This launcher is strictly for local SQLite testing. Do not let an exported
# production DATABASE_URL redirect local actions (including imports) to Neon.
unset DATABASE_URL

PYTHON_BIN=python3
if [ -n "$UNACH_PYTHON" ]; then
  PYTHON_BIN="$UNACH_PYTHON"
fi
"$PYTHON_BIN" -c "import openpyxl, reportlab" >/dev/null 2>&1 || {
  echo "Faltan dependencias. Instálalas con: python3 -m pip install -r requirements.txt" >&2
  exit 1
}
exec "$PYTHON_BIN" app.py
