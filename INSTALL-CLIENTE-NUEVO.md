# Checklist — instalación cliente nuevo

Instalación dedicada (un proyecto Firebase por cliente). Seguí estos pasos en orden.

## 1. Marca (branding)

- [ ] Editar `frontend-libro-guardia/src/config/brand.js`:
  - [ ] `companyName`
  - [ ] `appTitle`
  - [ ] `loginTitle`
  - [ ] `logoPath` (nombre del archivo en `/public`)
  - [ ] `logoAlt`
  - [ ] `primaryColor` (ej. `#dc2626`)
  - [ ] `primaryColorHover`
  - [ ] `backgroundColor`
  - [ ] `loginSubtitle`
  - [ ] `headerSubtitle`
  - [ ] `kioskTitle`
  - [ ] `kioskSubtitle`
  - [ ] `footerText`
  - [ ] `pdfReportTitle` (PDF del Historial)
  - [ ] `pdfSummaryReportTitle` (PDF del panel Reportes gerenciales)
  - [ ] `metaDescription`
  - [ ] `shortName`
  - [ ] `themeStorageKey` (único por cliente, ej. `acme-theme`)
  - [ ] `loginUsernamePlaceholder`
- [ ] Reemplazar el logo en `frontend-libro-guardia/public/` con el mismo nombre que `logoPath` (hoy: `B roja.png`), o poner el archivo nuevo y actualizar `logoPath`.

## 2. Favicons (manual — no los genera brand.js)

Reemplazar en `frontend-libro-guardia/public/`:

- [ ] `favicon.ico`
- [ ] `favicon-16.png`
- [ ] `favicon-32.png`
- [ ] `favicon-512.png` (también apple-touch-icon)
- [ ] Opcional: `logo192.png`, `logo512.png` (si se usan en PWA / assets viejos)

## 3. Firebase del cliente

- [ ] Crear proyecto Firebase nuevo (Hosting + Functions + Firestore).
- [ ] Actualizar `.firebaserc` con el `project_id` del cliente (y el target de hosting si aplica).
- [ ] Revisar `firebase.json` / `frontend-libro-guardia/firebase.json` (target de hosting).
- [ ] Configurar variables de entorno / secrets de Cloud Functions para ese proyecto (no compartir los de otro cliente):
  - [ ] `JWT_SECRET` (obligatorio)
  - [ ] `SETUP_KEY` (bootstrap de usuarios iniciales; cambiar el default)
  - [ ] `ALLOWED_ORIGINS` (orígenes del frontend del cliente)
- [ ] En frontend, para prod dejar `REACT_APP_API_BASE_URL=/api` (`.env.production`).
- [ ] En desarrollo, apuntar `.env.development` a la API del cliente nuevo (no a Bacar).
- [ ] Crear secret `FIREBASE_SERVICE_ACCOUNT` en el repo de GitHub del cliente (JSON de cuenta de servicio con Firebase Admin). Ver sección *GitHub Actions* en [README.md](./README.md).

## 4. Build y verificación

```bash
cd frontend-libro-guardia
npm install
npm test -- --watchAll=false
npm run build
```

```bash
cd functions
npm install
npm test
```

- [ ] Confirmar que el build regeneró `public/index.html` y `public/manifest.json` con los textos/colores del cliente (`prebuild` = `apply-brand`).
- [ ] Abrir la app en local (`npm start`) y chequear: login, header, kiosko, colores, logo.
- [ ] Confirmar suites en verde (frontend + functions) antes de desplegar.

## 5. Deploy

**Opción A — GitHub Actions:** push a `main` (o *Actions → CI → Run workflow*). Requiere el secret del paso 3.

**Opción B — Manual** desde la raíz del repo (`LG/`):

```bash
cd functions
npm install
cd ..
firebase use <project_id_del_cliente>
firebase deploy --only "hosting,functions"
```

- [ ] Si el target de hosting no es `bacarguard`, usar el target definido en `.firebaserc` del cliente.
- [ ] Verificar URL de Hosting del cliente (login + kiosko + un escaneo de prueba).
- [ ] Puente SR201: `.\scripts\deploy-sr201-bridge.ps1` desde la PC de planta (no desde Actions). El driver por puerta se configura en Admin → Puertas (`device.driver`: `sr201` o `generic_http`).

## 6. Post-deploy

- [ ] Bootstrap de usuarios: `POST /api/setup/initial-users` con header/body `x-setup-key` / `setupKey` (valor de `SETUP_KEY`), o crear admin con `functions/create-admin.js`.
- [ ] Entrar como admin y cambiar la contraseña (flujo `mustChangePassword` / “Mi contraseña”).
- [ ] (Opcional) Admin → Notificaciones: SMTP y eventos (ingresos excepcionales, denegaciones repetidas, fallo de relay, acciones sensibles).
- [ ] (Opcional) Verificar Admin → Auditoría y el menú Reportes (permiso `reports.export`).
- [ ] No reutilizar datos, reglas ni secrets de otra instalación.
