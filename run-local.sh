#!/bin/sh
set -e

PYTHON_BIN=python3
if [ -n "$UNACH_PYTHON" ]; then
  PYTHON_BIN="$UNACH_PYTHON"
fi
"$PYTHON_BIN" -c "import openpyxl, reportlab" >/dev/null 2>&1 || {
  echo "Faltan dependencias. Instálalas con: python3 -m pip install -r requirements.txt" >&2
  exit 1
}
exec "$PYTHON_BIN" app.py
