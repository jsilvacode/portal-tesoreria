#!/usr/bin/env python3
"""Activate a pre-registered owner account; never accepts or prints passwords."""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app

parser = argparse.ArgumentParser()
parser.add_argument('--email', required=True)
parser.add_argument('--activate', action='store_true')
parser.add_argument('--local', action='store_true')
args = parser.parse_args()
if args.local:
    os.environ.pop('DATABASE_URL', None)
elif not os.environ.get('DATABASE_URL'):
    parser.error('Se requiere DATABASE_URL; usa --local solo para la base local.')
conn = app.connect()
try:
    row = conn.execute('SELECT id, email, status FROM users WHERE email = ?', (args.email.strip().lower(),)).fetchone()
    if not row:
        raise SystemExit('Registra primero la cuenta en el portal, definiendo allí su contraseña.')
    if args.activate:
        conn.execute("UPDATE users SET status = 'active', approved_at = ? WHERE id = ?", (app.utc_now(), row['id']))
        app.record_audit(conn, row['id'], 'owner_account_activated', {'source': 'server_configuration'})
        conn.commit()
    print('Cuenta:', row['email'])
    print('Configura UNACH_SUPERUSER_ID=' + str(row['id']) + ' en el servidor y vuelve a desplegar.')
finally:
    conn.close()
