# Guía de la carpeta scripts (en criollo)
#
# Acá vive TODO lo que corre en la PC de planta / portería:
# lectores, apertura de puertas y (si hace falta) el puente a internet.

## Qué es esta PC

Si tenés una sola máquina (tu PC de desarrollo = la de planta), **esta PC es la estación**.
No hace falta otra mini PC para probar.

---

## Archivos para doble clic (los importantes)

| Archivo | Cuándo usarlo |
|---------|----------------|
| **01-instalar-estacion.cmd** | Primera vez en la PC. Pedí un código de 6 dígitos en Admin → Lectores → Generar código. Ejecutá como Administrador y pegá el código. |
| **01b-reinstalar-servicio-estacion.cmd** | Ya instalaste alguna vez y solo querés volver a registrar el servicio (sin pedir código de nuevo). |
| **02-reiniciar-estacion.cmd** | Después de actualizar el programa o si “no abre” / “no lee”. Reinicia el servicio y te manda a Admin. |
| **03-arrancar-apertura-por-internet.cmd** | Solo si las puertas abren **a distancia** (desde internet) con túnel Cloudflare. Si abrís **en planta**, no lo necesitás. |

Orden tipico en una PC nueva:
1. `01-instalar-estacion.cmd`
2. Probar en https://mss-guard.web.app → Admin → Puertas → Probar apertura
3. (Opcional) `03-...` solo si usás apertura a distancia

---

## Programas (no hace falta abrirlos a mano)

| Archivo | Qué hace |
|---------|----------|
| **programa-estacion.js** | Cerebro de la estación: lee el lector, habla con MSS Guard y puede abrir la puerta en la red local. Corre como servicio de Windows. |
| **programa-apertura-internet.js** | Puente viejo pero útil: deja que MSS abra la placa por internet (puerto 5022 + túnel). |

---

## Configuración (datos de ESTA PC)

| Archivo | Qué es |
|---------|--------|
| **configuracion-estacion.json** | Tu config real (puerta, lector, secreto). **No se sube a GitHub** (tiene secretos). |
| **configuracion-estacion.ejemplo.json** | Modelo para copiar si arrancás de cero. |
| **configuracion-apertura-internet.json** | IP de la placa y secreto del puente a internet. |
| **configuracion-apertura-internet.ejemplo.json** | Modelo del puente a internet. |

Si todavía tenés `door-reader.config.json` o `sr201-bridge.config.json`, el programa los sigue leyendo por compatibilidad. Preferí los nombres nuevos.

---

## Carpetas

| Carpeta | Qué hay |
|---------|---------|
| **_interno/** | Scripts PowerShell que usan los `.cmd`. No hace falta tocarlos. |
| **lib/** | Traductores de marcas de lectores (ZK, HID, etc.). |
| **tools/** | NSSM (herramienta para instalar el servicio de Windows). Se descarga sola la primera vez. |
| **archivo-viejo/** | Cosas viejas / de otros proyectos. **No uses esto en el día a día.** |
| **node_modules/** | Dependencias de Node (serialport, etc.). |

---

## Qué NO toques / basura

- Archivos `.log` → son historial. Se pueden borrar si pesan mucho.
- `door-allowlist-*.json` / `offline-queue-*.json` → caché automática; se regeneran.
- No uses la página `http://127.0.0.1:8787/` para operar. Operá siempre desde **mss-guard.web.app**.

---

## Dos modos de abrir la puerta (para no confundirte)

1. **En planta (recomendado)**  
   Corre solo `programa-estacion`. La mini PC abre el relé por la red local.  
   Usá: `01` + `02`.

2. **A distancia (internet)**  
   Además necesitás `programa-apertura-internet` + túnel Cloudflare.  
   Usá también: `03`.

En Admin → Equipos de acceso → Puertas elegís el modo de cada puerta.

---

## Después de actualizar el código

1. Asegurate de tener los archivos nuevos en esta carpeta (`programa-estacion.js`, etc.).
2. Doble clic en **02-reiniciar-estacion.cmd** (como Administrador).
3. En el navegador: Ctrl+F5 en mss-guard.web.app y probá abrir.

**¿Hay que actualizar `programa-estacion.js` a mano?**  
No en el día a día. Ese archivo lo mantenemos en el repo (`Desktop\LG\scripts`). El servicio de Windows apunta a **esa misma carpeta**. Cuando hay un cambio importante (offline, lectores, etc.):

1. Yo (o un `git pull`) dejo el `.js` nuevo en `scripts\`.
2. Vos corrés **02-reiniciar-estacion.cmd** una vez.
3. Listo: no hace falta editar el archivo a mano ni copiarlo a otro lado **si la estación es esta misma PC**.

Si en el futuro la estación es **otra mini PC** distinta de esta, ahí sí hay que copiar la carpeta `scripts` (o al menos `programa-estacion.js` + `lib` + configs) a esa máquina y reiniciar el servicio.

**¿Cada cuánto?** Solo cuando haya una mejora o corrección del programa de estación. No es periódico. El panel web (mss-guard) se actualiza solo con el deploy; el `.js` de la PC **no** se actualiza solo por internet.

Si renombramos el programa y el servicio sigue apuntando al nombre viejo, corré **01b-reinstalar-servicio-estacion.cmd** una vez.
