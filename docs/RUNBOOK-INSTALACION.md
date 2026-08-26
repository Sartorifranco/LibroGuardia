# Runbook técnico — instalación MSS

Solo para el equipo. El cliente no recibe este archivo.

El checklist de fases está en [INSTALL-CLIENTE-NUEVO.md](../INSTALL-CLIENTE-NUEVO.md).
Acá van comandos y trampas de Firebase / Windows.

Instalación dedicada: **un proyecto Firebase por cliente**.

---

## 1. Herramientas

- Node.js 20+
- Firebase CLI: `npm install -g firebase-tools` y `firebase login`
- Acceso al proyecto GCP/Firebase del cliente (plan **Blaze**)
- PowerShell en las PCs de planta (Windows)

## 2. Proyecto Firebase

1. Crear proyecto en https://console.firebase.google.com/
2. Habilitar **Firestore** en modo producción, región `southamerica-east1` salvo que el cliente pida otra.
3. Habilitar **Hosting** y **Functions**.
4. En la raíz del repo del cliente:

```json
{
  "projects": { "default": "<project_id_del_cliente>" }
}
```

Ajustar también el target de Hosting en `.firebaserc` / `firebase.json` si no se usa `mss-guard`.

5. Variables de Cloud Functions (no copiar las de Bacar):

| Variable | Notas |
|----------|--------|
| `JWT_SECRET` | Obligatorio. Largo y único por cliente. |
| `SETUP_KEY` | Bootstrap de usuarios. Cambiar el default de `auth.js`. |
| `ALLOWED_ORIGINS` | Orígenes del frontend (`https://<hosting>.web.app`, `localhost:3000` si hace falta). |
| `UBIKA_API_URL` / `UBIKA_API_TOKEN` | Solo si hay flota UBIKA. |

Plantilla: `functions/.env.example`. No commitear `.env` ni `serviceAccountKey.json`.

6. Frontend:

- Producción: `frontend-libro-guardia/.env.production` → `REACT_APP_API_BASE_URL=/api`
- Desarrollo: `.env.development` apuntando a **ese** Functions, no a Bacar.

## 3. Marca (automatizable)

Desde `frontend-libro-guardia/`:

```powershell
npm run test:brand
npm run scaffold-brand -- --from ..\clients\<cliente>.json --force
npm run apply-brand
```

Sin `--force` no pisa un `companyName` distinto al actual. `--dry-run` no escribe; si la marca actual es otra, sumá `--force` para ver el preview. El archivo de `logoFile` tiene que existir o el comando aborta sin tocar `brand.js`. Favicons no los genera el scaffold (dependen de `sharp`, que no es dependencia del frontend).

## 4. Verificación antes de desplegar

```powershell
cd frontend-libro-guardia
npm install
npm run test:brand
npm test -- --watchAll=false
npm run build

cd ..\functions
npm install
npm test
```

Confirmar que `public/index.html` y `public/manifest.json` quedaron con el `appTitle` / `theme-color` del cliente (`apply-brand` corre en `prebuild`).

## 5. Deploy

**GitHub Actions:** secret `FIREBASE_SERVICE_ACCOUNT` (JSON de cuenta de servicio con rol Firebase Admin) en el repo del cliente. Push a `main` o *Actions → CI → Run workflow*. Cómo generar el JSON: [README.md](../README.md) § Deploy.

**Manual:**

```powershell
firebase use <project_id_del_cliente>
firebase deploy --only "hosting,functions"
```

Fallback histórico: `.\scripts\deploy-firebase.ps1` (revisar que el `project_id` sea el del cliente).

El puente SR201 **no** se despliega desde Actions. En planta:

```powershell
.\scripts\deploy-sr201-bridge.ps1
```

## 6. Primeros usuarios

Opción A — HTTP (una vez, con `SETUP_KEY`):

`POST /api/setup/initial-users` con header `x-setup-key` o body `setupKey`.

Opción B — script local (hace falta `functions/serviceAccountKey.json` del **cliente**):

```powershell
cd functions
node create-admin.js admin <password-temporal>
```

Entrar y cambiar la contraseña (`mustChangePassword` / “Mi contraseña”).

## 7. Hardware en planta

| Qué | Doc |
|-----|-----|
| Relé / molinete SR201 | [INSTALACION-SR201.md](./INSTALACION-SR201.md) |
| Lector desatendido | [INSTALACION-LECTOR-PUERTA.md](./INSTALACION-LECTOR-PUERTA.md) |
| Multi-puertas | [MULTI-PUERTAS.md](./MULTI-PUERTAS.md) |
| Citados (carpeta Excel/CSV) | [CITACIONES-FOLDER-BRIDGE.md](./CITACIONES-FOLDER-BRIDGE.md) — módulo opcional |
| GPS flota | [GPS-PROVEEDOR.md](./GPS-PROVEEDOR.md) — API del proveedor, no hardware en el vehículo |

La app en Firebase no habla TCP con el relé: hace falta PC local + puente HTTP.

## 8. Lo que no hay que hacer

- Reusar Firestore, reglas o secrets de otra instalación.
- Correr `scaffold-brand` sobre el árbol de Bacar “para probar” (sin `--force` ahora aborta; con `--force` sí pisa).
- Dejar el API Node+Mongo de `legacy/` — está descartado.
- Prometer Citados o un GPS que no sea UBIKA como “ya incluido” sin el conector.
