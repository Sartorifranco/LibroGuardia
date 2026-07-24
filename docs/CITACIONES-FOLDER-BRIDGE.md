# Citaciones folder bridge â€” en uso, mantener

**Estado:** servicio local de planta **en uso**. No descontinuar.  
**Script:** `scripts/citaciones-folder-bridge.js`  
**Rol:** vigilar una carpeta local de planillas Excel/CSV de citados (transporte) y sincronizarlas con Cloud Functions (`POST /api/bridge/citaciones/sync`).

Este puente es del mismo tipo que el SR201: proceso mÃ­nimo en una PC de planta, **sin Mongo**, sin lÃ³gica de usuarios. La autorizaciÃ³n y persistencia viven en Firebase.

---

## Servicios locales que deben seguir corriendo en planta

| Servicio | Script | Â¿Retirar con Node+Mongo? |
|----------|--------|---------------------------|
| Puente SR201 (molinete/puertas) | `scripts/sr201-bridge.js` | **No** â€” mantener |
| Puente citaciones Excel | `scripts/citaciones-folder-bridge.js` | **No** â€” mantener (en uso) |
| API Node+Mongo (`bacarguard-api`) | `legacy/backend-libro-guardia` | **SÃ­** â€” descartado (sin migraciÃ³n); apagar en planta con comandos en `MIGRACION-BACKEND.md` Â§13 |

Ver tambiÃ©n: [INSTALACION-SR201.md](./INSTALACION-SR201.md) Â· [MIGRACION-BACKEND.md](./MIGRACION-BACKEND.md)

---

## QuÃ© hace

1. Observa `watchFolder` (chokidar) en busca de archivos nuevos o modificados.
2. Espera a que el archivo deje de crecer (`stableMs`, por defecto 2,5 s).
3. Lee filas `.xlsx` / `.xls` / `.csv` (incluye formato transporte CSV embebido).
4. EnvÃ­a el lote a `apiBaseUrl/bridge/citaciones/sync` con `Authorization: Bearer <bridgeSecret>`.
5. Marca el archivo como procesado (estado local) y, opcionalmente, lo mueve a otra carpeta.

**Frecuencia:** no es un cron periÃ³dico. Reacciona a eventos del sistema de archivos (`add` / `change`). Al arrancar tambiÃ©n procesa lo que ya haya en la carpeta (`ignoreInitial: false`). Entre archivos espera `pauseBetweenFilesMs` (default 3 s).

---

## Requisitos

- Node.js 18+ en la PC del encargado de transporte (o la que reciba las planillas).
- Dependencias en `scripts/` (`chokidar`, `xlsx` â€” `npm install` dentro de `scripts/` si hace falta).
- Acceso a internet hacia `https://mss-guard.web.app` (o la API configurada).
- Secreto de bridge igual al configurado en **Admin â†’ Autorizaciones / Citaciones bridge**.

---

## InstalaciÃ³n

```powershell
cd C:\LG\scripts
copy citaciones-bridge.config.example.json citaciones-bridge.config.json
# Editar citaciones-bridge.config.json (ver abajo)
npm install
node citaciones-folder-bridge.js
```

Config de ejemplo: `scripts/citaciones-bridge.config.example.json`.

---

## Variables / configuraciÃ³n (`citaciones-bridge.config.json`)

| Campo | Obligatorio | DescripciÃ³n |
|-------|-------------|-------------|
| `watchFolder` | SÃ­ | Carpeta local a vigilar (ej. `C:\CitacionesTransporte` o `C:\usr`) |
| `apiBaseUrl` | SÃ­ | Base API, sin barra final de mÃ¡s: `https://mss-guard.web.app/api` |
| `bridgeSecret` | SÃ­ | Mismo valor que Admin â†’ Citaciones bridge (Bearer) |
| `fileNamePrefix` | No | Solo archivos cuyo nombre empiece asÃ­ (ej. `Citaciones_`) |
| `fileExtensions` | No | Default `[".xlsx",".xls",".csv"]` |
| `defaults.type` | No | Tipo de autorizaciÃ³n al sync (default `citacion`) |
| `defaults.company` | No | Empresa por defecto (ej. `Transporte`) |
| `stableMs` | No | Ms de estabilidad del archivo antes de leerlo (default `2500`) |
| `pauseBetweenFilesMs` | No | Pausa entre archivos (default `3000`) |
| `statusPort` | No | Puerto status local `127.0.0.1` (default `5023`) |
| `moveProcessedTo` | No | Si se setea, mueve el archivo procesado a esa carpeta |
| `logFile` | No | Archivo de log relativo a `scripts/` o absoluto |

El secreto **no** debe subirse a git. `citaciones-bridge.config.json` suele estar en el servidor (el `.example` es la plantilla).

---

## CÃ³mo correr con PM2

```powershell
cd C:\LG\scripts
pm2 start citaciones-folder-bridge.js --name bacarguard-citaciones-bridge
pm2 save
pm2 startup   # si aÃºn no estÃ¡ configurado el arranque con Windows
```

Comandos Ãºtiles:

```powershell
pm2 status
pm2 logs bacarguard-citaciones-bridge
pm2 restart bacarguard-citaciones-bridge
```

Nombre sugerido alineado al del SR201: `bacarguard-citaciones-bridge` (el SR201 usa `bacarguard-sr201-bridge`).

---

## Verificar que estÃ¡ corriendo

1. **PM2:** `pm2 status` â†’ proceso `online`.
2. **Status HTTP local** (default puerto 5023):

```powershell
Invoke-RestMethod http://127.0.0.1:5023
```

Respuesta esperada (ejemplo):

```json
{
  "service": "citaciones-folder-bridge",
  "watching": "C:\\usr",
  "apiBaseUrl": "https://mss-guard.web.app/api",
  "processing": [],
  "lastSuccess": { "file": "Citaciones_2026_07_14.xlsx", "at": "..." },
  "lastError": null,
  "processedCount": 12
}
```

3. **Prueba operativa:** copiar un Excel de prueba con prefijo correcto a `watchFolder` y verificar en Admin que aparezcan las citaciones / imports.

Si el puerto 5023 estÃ¡ ocupado, el puente **sigue sincronizando**; solo se desactiva el status HTTP (queda logueado en consola).

---

## Carpeta vigilada y filtros

- Carpetas tÃ­picas: la que use transporte para dejar planillas (en example: `C:\usr`).
- Solo se procesan archivos en el **nivel raÃ­z** de `watchFolder` (`depth: 0`).
- Con `fileNamePrefix: "Citaciones_"` se ignoran otros Excel de la misma carpeta.
- Extensiones por defecto: `.xlsx`, `.xls`, `.csv`. TambiÃ©n archivos sin extensiÃ³n si coinciden con el prefijo.

---

## Checklist puesta en marcha (citaciones)

- [ ] `citaciones-bridge.config.json` creado desde el example
- [ ] `watchFolder` accesible y con permisos de lectura
- [ ] `bridgeSecret` coincide con Admin
- [ ] `apiBaseUrl` apunta a producciÃ³n (`https://mss-guard.web.app/api`)
- [ ] `node citaciones-folder-bridge.js` o PM2 activo 24/7
- [ ] `GET http://127.0.0.1:5023` responde OK
- [ ] Archivo de prueba sincroniza y aparece en Admin / autorizaciones del dÃ­a

Fecha: ___________  
Responsable: ___________
