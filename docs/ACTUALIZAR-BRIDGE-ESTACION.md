# Probar / actualizar el bridge en ESTA PC

Si tenés **una sola PC** (desarrollo = estación), olvidate de “mini PC”:  
**esta máquina es la estación** (`PC Franco` / `192.168.0.10`).

---

## Lo más simple (recomendado)

1. En el Explorador: `Desktop\LG\scripts\`
2. Click derecho en **`probar-apertura-local.cmd`** → **Ejecutar como administrador**
3. Aceptá el UAC
4. Se abre el navegador en `http://127.0.0.1:8787/`
5. En la página:
   - el **secreto** ya te lo muestra la ventana negra (copiá/pegá)
   - **IP del relé** = Host de Admin → Puertas (ej. `192.168.0.38`)
   - **Cargar puertas** → **Abrir**

Eso reinicia el servicio y carga el `door-reader-bridge.js` nuevo. Un solo doble clic.

---

## Por qué `actualizar-bridge.cmd` “se queda ahí”

Sin permisos de Administrador **no puede reiniciar el servicio**.  
El archivo en disco puede ser 1.2.0 y el proceso viejo seguir en 1.1.0.  
Por eso existe `probar-apertura-local.cmd` (reinicia + abre el navegador).

---

## Cuando haya varias estaciones (más adelante)

Por cada PC de planta: copiar `door-reader-bridge.js` + correr `probar-apertura-local.cmd` (o `actualizar-bridge.cmd`) como Admin.  
El sitio web se actualiza una sola vez desde desarrollo.
