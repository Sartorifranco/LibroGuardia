# Etapa 2 · Hito 1 en el banco (sin desplegar)

Guía paso a paso para probar en la PC del banco la cadena nueva **nube → hub → controlador → relé**, sin tocar Cloud Functions ni el hosting. Pensada para alguien que no programa: copiar y pegar los comandos en PowerShell, en el orden indicado.

| Pieza | Qué es en el banco | Dónde escucha |
|---|---|---|
| "Nube" | La API local de siempre (`local-api.js`), el mismo código de Cloud Functions corriendo en esta PC | `http://127.0.0.1:5057/api` |
| Hub | `scripts/edge/mss-edge.js --role=hub` | `http://<PC>:8080` |
| Controlador | `scripts/edge/mss-edge.js --role=controller`, maneja la puerta con el SR201 | `http://127.0.0.1:8790` |
| Relé | SR201 `192.168.0.38:6722`, canal 1 | — |
| Lector | Modo consola (`--stdin-reader`): se tipea el DNI y Enter. El lector DNI de COM3 hoy no está conectado | — |

> **Importante: la API local usa el Firestore REAL del proyecto de pruebas** (`legajosonline-959f6`). Al arrancar, el compilador escribe documentos nuevos en `sites/principal/...` (head, chunks, clave de credenciales, journal, comandos, alarmas) y los ingresos concedidos aparecen en el libro (`entries`, con `entrySource: 'edge'`). Es un sistema de pruebas: está bien, pero conviene saberlo.

> **La estación vieja sigue igual.** El servicio NSSM de la estación (puerto 8787) no se toca ni se detiene. Los puertos nuevos (5057, 8080, 8790) no chocan con él. Ojo: **la estación vieja y el controlador nuevo pueden accionar el mismo SR201**; si se prueban los dos a la vez el relé puede recibir dos pulsos seguidos. Cuando se conecte el lector de COM3, **solo un programa puede abrir COM3** (o la estación vieja o el controlador nuevo, no los dos).

---

## 0. Antes de empezar (una sola vez)

1. El código tiene que incluir la rama `fix/etapa2-contratos` (integrada en `integracion/revision-2026-10`). En `C:\Users\Admin\Desktop\LG`:
   ```powershell
   cd C:\Users\Admin\Desktop\LG
   git status            # debe decir la rama que integra fix/etapa2-contratos
   ```
2. Dependencias (ya instaladas en el banco; solo si faltan):
   ```powershell
   cd C:\Users\Admin\Desktop\LG\functions; npm install
   cd C:\Users\Admin\Desktop\LG\scripts;   npm install     # trae better-sqlite3 para Node 20
   ```
3. Prueba automática de punta a punta (no toca Firestore real, tarda ~2 s):
   ```powershell
   cd C:\Users\Admin\Desktop\LG\functions
   npm run test:e2e
   ```
   Tiene que terminar con `# fail 0` e imprime cuántas lecturas/escrituras de Firestore usó el escenario.
4. Carpeta de trabajo del banco: `C:\mss-edge` (la crean los comandos; no va al repo).

## 1. Clave de firma de la "nube" (una sola vez)

La nube firma la configuración que baja a los equipos. Si la API local arranca sin clave fija, inventa una distinta cada vez y, después de reiniciarla, el hub **rechaza la config** (`bad_signature`). Por eso se genera una clave fija:

```powershell
cd C:\Users\Admin\Desktop\LG
node scripts\edge\tools\enroll-local.js clave-nube --dir C:\mss-edge
```

Queda en `C:\mss-edge\nube\firma-ed25519.pem`. **No copiarla a otros equipos ni subirla al repo.**

## 2. Ventana 1 — arrancar la "nube" (API local)

Abrir una ventana de PowerShell **nueva** y dejarla abierta todo el tiempo:

```powershell
$env:EDGE_SIGNING_PRIVATE_KEY = Get-Content -Raw "C:\mss-edge\nube\firma-ed25519.pem"
node <scratch>\local-api.js C:/Users/Admin/Desktop/LG/functions 5057
```

(`<scratch>` = la carpeta donde está `local-api.js`, la misma que se usa siempre para probar.)

Tiene que decir `API local en http://127.0.0.1:5057`. **Cada vez que se reinicie la API hay que volver a ejecutar la primera línea en esa ventana** (si no, ver "Problemas" → `bad_signature`).

## 3. Elegir la puerta

La puerta que maneja el SR201 `192.168.0.38` canal 1 tiene un id (por ejemplo `puerta-p1`). Se ve en Admin → Puertas, o la herramienta del paso 4 lista los ids si se equivoca. En esta guía se usa `puerta-p1`; reemplazar si es otro.

Asignarle un controlador **no cambia nada para la estación vieja**: solo hace que las aperturas remotas nuevas (`/remote-open`) vayan por el controlador.

## 4. Ventana 2 — dar de alta y enrolar hub y controlador

```powershell
cd C:\Users\Admin\Desktop\LG
$env:MSS_ADMIN_PASSWORD = Read-Host "Contraseña de admin"     # se tipea, no queda en el historial
node scripts\edge\tools\enroll-local.js enrolar --api http://127.0.0.1:5057/api --user admin --door puerta-p1 --dir C:\mss-edge --sr201 192.168.0.38:6722:1
Remove-Item Env:MSS_ADMIN_PASSWORD
```

Hace, por la API de administración (lo mismo que hará la pantalla de Admin):

1. Inicia sesión como `admin`.
2. Da de alta un **hub** y un **controlador** (`POST /api/admin/devices`) y los enrola con claves Ed25519 nuevas (`POST /api/edge/v1/enroll`).
3. Asigna la puerta al controlador (`controllerId` en `settings/doorsConfig`) → la nube recompila.
4. Verifica que la API firma con la clave del paso 1 (si no, avisa con ⚠).
5. Escribe `C:\mss-edge\hub\config.json` y `C:\mss-edge\controller\config.json` (con sus claves en `keys\` y `claves\`).

Al final muestra los dos comandos de arranque. Se puede repetir (crea equipos nuevos; los viejos quedan sin uso — ver "Limpieza").

<details><summary>Lo mismo a mano con curl (opcional)</summary>

```powershell
$api = "http://127.0.0.1:5057/api"
$login = Invoke-RestMethod -Method Post -Uri "$api/auth/login" -ContentType application/json -Body (@{username='admin'; password=(Read-Host 'Contraseña')} | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($login.token)" }
Invoke-RestMethod -Method Post -Uri "$api/admin/devices" -Headers $h -ContentType application/json -Body '{"siteId":"principal","kind":"hub","name":"Hub banco"}'
Invoke-RestMethod -Method Post -Uri "$api/admin/devices" -Headers $h -ContentType application/json -Body '{"siteId":"principal","kind":"controller","name":"Controlador banco","doorIds":["puerta-p1"]}'
# Cada respuesta trae enrollment.code (vale 10 min, un solo uso). El canje del código con la clave
# pública del equipo (POST /api/edge/v1/enroll) y los config.json los arma enroll-local.js.
```
</details>

## 5. Ventana 3 — hub

```powershell
cd C:\Users\Admin\Desktop\LG
node scripts\edge\mss-edge.js --role=hub --config C:\mss-edge\hub\config.json
```

Tiene que mostrar `escuchando en 0.0.0.0:8080` y, en pocos segundos, `config vN aplicada`. El hub consulta la nube cada 15 s (cabeza de config + aviso de comandos pendientes) y sube eventos cada 30 s (las alarmas, enseguida).

## 6. Ventana 4 — controlador con lector por consola

```powershell
cd C:\Users\Admin\Desktop\LG
node scripts\edge\mss-edge.js --role=controller --config C:\mss-edge\controller\config.json --stdin-reader puerta-p1
```

Tiene que mostrar `Controlador ... listo` y `Config aplicada {"version":N, ...}` (llega por el hub, firmada por la nube; incluye la clave HMAC de DNI en el chunk `secrets`).

## 7. Probar el acceso

En la **ventana 4** escribir un DNI y Enter:

- DNI de una persona activa con autorización vigente para esa puerta → `Acceso grant (...)` y **el relé hace clic** (pulso de 3 s).
- DNI desconocido (`99999999`) → `Acceso deny (credencial_desconocida)`, sin clic.

Estado del hub (en el navegador o PowerShell): `http://127.0.0.1:8080/edge/status` → `configVersion`, `cloudOnline`, eventos pendientes y, por controlador, `configVersionApplied`/`online`.

## 8. Verificar en Firestore (consola web del proyecto de pruebas)

- `sites/principal/compiled/head`: `version` (la misma que muestran hub y controlador).
- `devices/{id del controlador}`: `configVersionApplied`, `online`, `reportedBy` (lo informa el hub en su heartbeat, solo cuando cambia).
- `sites/principal/journal/{AAAAMMDD}_{hub}_{n}`: lotes de eventos (concedidos y denegados), cada uno una sola vez.
- `entries`: los ingresos concedidos, con `entrySource: 'edge'`, `name`, `doorId`, `edge.eventId` (aparecen en el libro).
- `sites/principal/status/hub`: último lote confirmado (`ackHubSeq`).
- `sites/principal/alarms`: alarmas (por ejemplo `credential_key_missing`, `door_forced`).

## 9. Simular "se cortó internet"

1. En la **ventana 1**, `Ctrl + C` (se apaga la "nube").
2. En la ventana 4 escanear varios DNI: **sigue decidiendo igual** (abre y niega) sin nube.
3. `http://127.0.0.1:8080/edge/status` → `cloudOnline: false` y `events.pending` creciendo.
4. Volver a arrancar la nube en la ventana 1 **con las dos líneas del paso 2** (la variable de la clave incluida).
5. El hub reintenta solo (30 s, 1, 2, 4… hasta 10 min de espera entre intentos). Para no esperar: `Ctrl + C` en la ventana 3 y volver a arrancar el hub (sube a los ~30 s).
6. Verificar en `sites/principal/journal` y `entries` que están todos los eventos del corte **una sola vez**.

## 10. Simular "se cayó el hub"

1. `Ctrl + C` en la ventana 3.
2. Escanear en la ventana 4: el controlador **decide solo** (con su copia local) y guarda los eventos.
3. Volver a arrancar el hub (paso 5). En segundos el controlador le pasa lo acumulado y el hub lo sube a la nube.

## 11. Apertura remota desde la nube

Todavía no hay botón en la pantalla para esto; se prueba por la API (ventana 2):

```powershell
$api = "http://127.0.0.1:5057/api"
$login = Invoke-RestMethod -Method Post -Uri "$api/auth/login" -ContentType application/json -Body (@{username='admin'; password=(Read-Host 'Contraseña')} | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($login.token)" }
$r = Invoke-RestMethod -Method Post -Uri "$api/guard/doors/puerta-p1/remote-open" -Headers $h -ContentType application/json -Body '{"reason":"prueba banco"}'
$r.command                                   # status: pending
Start-Sleep 20
(Invoke-RestMethod -Uri "$api/guard/commands/$($r.command.id)" -Headers $h).command   # status: done, result.relayConfirmed: True
```

Camino: la nube deja el comando y suma 1 a `sites/principal/status/commands.pending`; en su próxima consulta (≤ 15 s) el hub ve `pendingCommands > 0`, pide `GET /api/edge/v1/commands`, se lo manda firmado al controlador, el relé hace clic y el resultado real vuelve a la nube. El comando vence a los 45 s: si el hub no lo tomó, queda `expired`.

Para un estanco forzado: `{"forceAirlock":true,"forceReason":"motivo de al menos 5 letras"}` (requiere el permiso `puertas.estanco.forzar`; el hub le avisa al controlador que ya está autorizado).

## 12. Cambio de permisos

1. En Admin, quitarle la autorización (o la puerta) a la persona de la prueba.
2. Esperar ≤ 15 s: el hub muestra `config vN+1 aplicada` y el controlador `Config aplicada`.
3. Escanear su DNI → `deny`.

## Problemas frecuentes

| Se ve | Causa | Qué hacer |
|---|---|---|
| Hub: `head vN con firma inválida` / `bad_signature` | La API local arrancó sin `$env:EDGE_SIGNING_PRIVATE_KEY` | Cerrar la API y arrancarla con las dos líneas del paso 2 |
| Hub: `NOT_ENROLLED` o `BAD_REFRESH` / `REFRESH_REUSED` | Se borró `C:\mss-edge\hub\data` o se reusó un enrolamiento viejo | Repetir el paso 4 (equipos nuevos) |
| Controlador: `Config rechazada ... missing_chunks ["secrets"]` y alarma `credential_key_missing` | El hub no tiene el chunk de la clave (hub viejo) | Actualizar el código y reiniciar el hub |
| Controlador: `SR201: no se pudo enviar ON` | La placa no responde (IP, cable, otra PC usándola) | `ping 192.168.0.38`; el acceso igual queda registrado como concedido con `relayConfirmed:false` |
| `EADDRINUSE` | Ya hay algo en 8080/8790/5057 | Cerrar la otra ventana o cambiar `--hub-port`/`--ctl-port` en el paso 4 |
| La apertura remota queda `expired` | El hub estaba apagado o sin nube > 45 s | Arrancar el hub y repetir |

## Limpieza

- Parar las ventanas 1, 3 y 4 con `Ctrl + C`.
- Empezar de cero: borrar `C:\mss-edge\hub\data` y `C:\mss-edge\controller\data` y repetir el paso 4.
- Dar de baja equipos sin uso: `POST /api/admin/devices/{id}/revoke` (Admin), o dejarlos (no hacen nada sin su clave).
- La estación vieja (NSSM, :8787) nunca se tocó.

## Costo (referencia)

La prueba automática (`npm run test:e2e`) recorre alta, config, escaneos, corte de internet, hub caído, apertura remota y cambio de permisos con ~70 lecturas y ~45 escrituras de Firestore en total. En marcha, el hub del banco con consulta cada 15 s hace ~3 lecturas por consulta (head + `_dirty` + contador de comandos ≈ 17.000 lecturas/día): **en producción el intervalo va en 60 s** (≈ 4.300/día) hasta que el listener de Firestore (fase 2) lo reemplace.
