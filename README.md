# Tesorería UNACH

Portal PWA para consultar y administrar informes financieros.

## Inicio local

Requiere Python 3.10+, las dependencias de `requirements.txt` y la planilla autorizada en `documentos-base/reporte-contable-2026-09-22.xlsx`. La planilla y la base local no se incluyen en este repositorio.

```sh
python3 -m pip install -r requirements.txt
export UNACH_TREASURER_EMAIL="tesorero@ejemplo.org"
export UNACH_TREASURER_PASSWORD="una-clave-segura-de-12-caracteres"
./run-local.sh
```

Abre `http://127.0.0.1:8000`.

## Vercel + Neon

Conecta el repo en Vercel, instala Neon desde Marketplace y habilita la integración para Production. Configura `UNACH_TREASURER_EMAIL` y `UNACH_TREASURER_PASSWORD` en Production; Neon proporciona `DATABASE_URL`. La primera solicitud crea el esquema y la cuenta de tesorería. Inicia sesión y carga el Excel inicial desde Administración. No subas la planilla, bases locales ni credenciales a GitHub.
