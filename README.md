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
