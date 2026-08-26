# Checklist — instalación cliente nuevo

Alguien del equipo que no escribió el producto debería poder completar esto
sin preguntar por chat. Un Firebase por cliente; no es multi-tenant.

Material que **no** ve el cliente: [docs/RUNBOOK-INSTALACION.md](./docs/RUNBOOK-INSTALACION.md)
(comandos Firebase, secrets, PowerShell).

Material que **sí** se puede mandar al cliente antes de la visita:
[docs/CLIENTE-DIA-INSTALACION.md](./docs/CLIENTE-DIA-INSTALACION.md).

---

## A. Antes de la visita (equipo técnico)

Hacerlo en una copia / rama / repo del **cliente**, no pisando la instalación de Bacar.

- [ ] Pedir al cliente: razón social, color primario (hex), logo PNG transparente, URL de Hosting prevista si ya la tienen, y cuáles módulos contrata (puertas, kiosko, flota GPS, Citados, BioStar).
- [ ] Crear el proyecto Firebase (Hosting + Functions + Firestore, plan Blaze). Pasos concretos en el runbook.
- [ ] Copiar `clients/brand.example.json`, completar `companyName` / `primaryColor` / `publicOrigin` / `logoFile`.
- [ ] Generar marca (no editar `brand.js` campo por campo):

```bash
cd frontend-libro-guardia
npm run scaffold-brand -- --from ../clients/<cliente>.json --force
npm run apply-brand
```

`--force` hace falta cuando el árbol todavía tiene otra marca (el default de este repo). Sin `--force` el script no escribe nada. El logo del JSON tiene que existir **antes** de correrlo: si falta, aborta sin tocar `brand.js`.

- [ ] Reemplazar favicons en `frontend-libro-guardia/public/` (`favicon.ico`, `favicon-16.png`, `favicon-32.png`, `favicon-512.png`). Si está `sharp`, se puede usar `node scripts/generate-favicon.js` (lee `brand.logoPath`).
- [ ] Apuntar `.firebaserc` y secrets al **proyecto del cliente** (`JWT_SECRET`, `SETUP_KEY`, `ALLOWED_ORIGINS`). Nunca reutilizar los de Bacar. Detalle en el runbook.
- [ ] Frontend prod: `REACT_APP_API_BASE_URL=/api`. Desarrollo: `.env.development` del cliente, no de Bacar.
- [ ] Secret de GitHub `FIREBASE_SERVICE_ACCOUNT` en el repo de **ese** cliente.
- [ ] Correr tests y build en local (runbook § verificación).
- [ ] Confirmar módulos opcionales:
  - Flota GPS: solo si el cliente ya tiene proveedor; guía de cotización en [docs/GPS-PROVEEDOR.md](./docs/GPS-PROVEEDOR.md). Hoy el conector listo es UBIKA.
  - Citados (planilla de personal esperado): no darlo por validado en un cliente nuevo hasta confirmar en Bacar que el puente sigue en uso (hallazgo operativo 4.11, aparte de este checklist).
  - BioStar / estaciones / SR201: hardware y PCs de planta se dejan para el día en sitio.

## B. En sitio con el cliente

- [ ] Deploy Hosting + Functions al proyecto del cliente (runbook § deploy).
- [ ] Bootstrap del usuario admin (`SETUP_KEY` o `create-admin.js`) y login.
- [ ] El admin cambia la contraseña en el primer ingreso.
- [ ] Verificar login, header, kiosko, logo y color (no alcanza con el build).
- [ ] Instalar puente de puertas en la PC de planta que va a quedar siempre encendida ([docs/INSTALACION-SR201.md](./docs/INSTALACION-SR201.md)). Driver por puerta: Admin → Puertas (`sr201` o `generic_http`).
- [ ] Si hay lector desatendido: [docs/INSTALACION-LECTOR-PUERTA.md](./docs/INSTALACION-LECTOR-PUERTA.md).
- [ ] Probar un pulso real de puerta / un escaneo de kiosko. Sin eso la visita no está cerrada.
- [ ] (Opcional) SMTP en Admin → Notificaciones, con el buzón que preparó el cliente.
- [ ] Entregar al encargado: URL de Hosting, usuario admin ya con password propia, y [docs/CLIENTE-DIA-INSTALACION.md](./docs/CLIENTE-DIA-INSTALACION.md) no aplica post-visita — dejar claro a quién avisar si una PC de planta se apaga.

## C. Post-instalación

- [ ] Importar nómina / personas cuando el cliente entregue la planilla (Admin). No reutilizar datos de otra instalación.
- [ ] Cargar puertas, destinos y usuarios de guardia con los roles reales.
- [ ] Si hay flota: geocercas y credenciales GPS en Admin, no en el frontend.
- [ ] Confirmar que el puente local arranca solo al reiniciar Windows (servicio / PM2 / tarea, según el runbook del hardware).
- [ ] Anotar en el expediente interno: `project_id`, URL de Hosting, PCs de planta, módulos activos. Eso no se publica al cliente.
- [ ] No dejar `SETUP_KEY` de default ni `serviceAccountKey.json` en discos de la visita.

### Criterio de “instalado”

Un compañero que no participó del desarrollo puede seguir A→B→C y dejar el sistema usable el mismo día, sin pasos ocultos en el chat del equipo.
