# Libro de Guardia Bacar â€” 100% Firebase

Todo el proyecto corre en Firebase. **Sin MongoDB, sin API Node local.**

| Componente | Servicio Firebase / local |
|---|---|
| Frontend | Hosting â†’ https://mss-guard.web.app |
| Backend / API | Cloud Functions â†’ `/api/*` |
| Base de datos | **Firestore** |
| Secretos | Firebase Secret Manager / `functions/.env` (`JWT_SECRET`) |
| Molinete (hardware) | Puente mÃ­nimo `scripts/sr201-bridge.js` en PC de planta |

---

## Requisitos previos

1. Cuenta Google con acceso al proyecto `legajosonline-959f6`
2. Plan **Blaze** activado (necesario para Cloud Functions)
3. Node.js 20+ y Firebase CLI:
   ```powershell
   npm install -g firebase-tools
   firebase login
   ```

---

## Paso 1 â€” Habilitar Firestore

1. AbrÃ­ https://console.firebase.google.com/project/legajosonline-959f6/firestore
2. Clic en **Create database**
3. ElegÃ­ modo **Production**
4. RegiÃ³n: **southamerica-east1** (SÃ£o Paulo, la mÃ¡s cercana)

---

## Paso 2 â€” Configurar JWT en functions/.env

```powershell
cd functions
copy .env.example .env
notepad .env
```

En `.env` ponÃ© el mismo valor secreto que usarÃ¡s en producciÃ³n, por ejemplo:

```
JWT_SECRET=BacarGuard_LG_2026_JWT_xK9mP2vQ7nR4wL8sT1
```

> No subas `.env` a Git. Se despliega con la Function automÃ¡ticamente.

---

## Paso 3 â€” Crear usuario admin en Firestore

**a)** DescargÃ¡ la clave de cuenta de servicio:
- https://console.firebase.google.com/project/legajosonline-959f6/settings/serviceaccounts/adminsdk
- Clic en **Generar nueva clave privada**
- GuardÃ¡ el JSON como `functions/serviceAccountKey.json`

**b)** EjecutÃ¡:

```powershell
cd functions
npm install
node create-admin.js admin Bacar2026
```

Debe decir: `Admin "admin" creado/actualizado en Firestore.`

> `firebase login` no alcanza para scripts locales; hace falta la clave JSON (no la subas a Git).

---

## Paso 4 â€” Desplegar todo

```powershell
cd C:\Users\Admin\Desktop\LG
.\scripts\deploy-firebase.ps1
```

---

## Paso 5 â€” Verificar

| URL | Resultado esperado |
|---|---|
| https://mss-guard.web.app/api/health | `{ "status": "ok", "database": "firestore" }` |
| https://mss-guard.web.app | Pantalla de login |

Login: **admin** / **Bacar2026**

---

## Colecciones Firestore (automÃ¡ticas)

| ColecciÃ³n | Contenido |
|---|---|
| `users` | Usuarios (id = username) |
| `entries` | Registros del libro |
| `personalMaster` | Base de personal |
| `mobiles` | MÃ³viles de flota |
| `drivers` | Choferes de flota |

---

## Flujo de trabajo diario

```powershell
# 1. EditÃ¡s cÃ³digo en tu PC
# 2. DesplegÃ¡s:
.\scripts\deploy-firebase.ps1
```

Sin copiar carpetas. Sin servidor. Sin MongoDB.

---

## Desarrollo local (opcional)

```powershell
firebase emulators:start --only functions,hosting,firestore
```

En otra terminal:
```powershell
cd frontend-libro-guardia
npm start
```

---

## Apagar el API Node+Mongo viejo (192.168.0.9)

Ya **no** se necesita Mongo ni `bacarguard-api` para Libro de Guardia.
**Fase 15:** confirmado en planta â€” sin datos relevantes; no se migra nada.
El cÃ³digo histÃ³rico quedÃ³ en `legacy/backend-libro-guardia/`.

```powershell
pm2 status
pm2 stop bacarguard-api
pm2 delete bacarguard-api
pm2 save
pm2 status
netstat -ano | findstr ":5020"
```

GuÃ­a completa: [docs/MIGRACION-BACKEND.md](./docs/MIGRACION-BACKEND.md) Â§13.

SÃ­ hacen falta los puentes locales (SR201 / citaciones) â€” ver [docs/INSTALACION-SR201.md](./docs/INSTALACION-SR201.md),
[docs/CITACIONES-FOLDER-BRIDGE.md](./docs/CITACIONES-FOLDER-BRIDGE.md) y `.\scripts\setup-servidor.ps1`.
