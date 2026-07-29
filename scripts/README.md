# Scripts — qué usar

Con **una sola PC**, esta máquina es la estación.

## Operar (abrir puerta)

1. Que el bridge esté corriendo (servicio Windows).
2. En el navegador: **https://mss-guard.web.app** → Admin → Puertas → **Probar apertura**.

## Después de actualizar el código del bridge

1. Click derecho en **`probar-apertura-local.cmd`** → Ejecutar como administrador.
2. Eso **solo reinicia** el servicio y te abre el Admin.
3. **No** uses la página `http://127.0.0.1:8787/` para operar (era el diagnóstico viejo).

## Archivos que no borrar

- `door-reader-bridge.js`
- `door-reader.config.json`
- `probar-apertura-local.cmd`
