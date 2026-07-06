# Libro de Guardia Bacar — 100% Firebase

Todo el proyecto corre en Firebase. **Sin MongoDB, sin servidor local.**

| Componente | Servicio Firebase |
|---|---|
| Frontend | Hosting → https://bacarguard.web.app |
| Backend / API | Cloud Functions → `/api/*` |
| Base de datos | **Firestore** |
| Secretos | Firebase Secret Manager (`JWT_SECRET`) |

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

## Paso 1 — Habilitar Firestore

1. Abrí https://console.firebase.google.com/project/legajosonline-959f6/firestore
2. Clic en **Create database**
3. Elegí modo **Production**
4. Región: **southamerica-east1** (São Paulo, la más cercana)

---

## Paso 2 — Configurar JWT en functions/.env

```powershell
cd functions
copy .env.example .env
notepad .env
```

En `.env` poné el mismo valor secreto que usarás en producción, por ejemplo:

```
JWT_SECRET=BacarGuard_LG_2026_JWT_xK9mP2vQ7nR4wL8sT1
```

> No subas `.env` a Git. Se despliega con la Function automáticamente.

---

## Paso 3 — Crear usuario admin en Firestore

**a)** Descargá la clave de cuenta de servicio:
- https://console.firebase.google.com/project/legajosonline-959f6/settings/serviceaccounts/adminsdk
- Clic en **Generar nueva clave privada**
- Guardá el JSON como `functions/serviceAccountKey.json`

**b)** Ejecutá:

```powershell
cd functions
npm install
node create-admin.js admin Bacar2026
```

Debe decir: `Admin "admin" creado/actualizado en Firestore.`

> `firebase login` no alcanza para scripts locales; hace falta la clave JSON (no la subas a Git).

---

## Paso 4 — Desplegar todo

```powershell
cd C:\Users\Admin\Desktop\LG
.\scripts\deploy-firebase.ps1
```

---

## Paso 5 — Verificar

| URL | Resultado esperado |
|---|---|
| https://bacarguard.web.app/api/health | `{ "status": "ok", "database": "firestore" }` |
| https://bacarguard.web.app | Pantalla de login |

Login: **admin** / **Bacar2026**

---

## Colecciones Firestore (automáticas)

| Colección | Contenido |
|---|---|
| `users` | Usuarios (id = username) |
| `entries` | Registros del libro |
| `personalMaster` | Base de personal |
| `mobiles` | Móviles de flota |
| `drivers` | Choferes de flota |

---

## Flujo de trabajo diario

```powershell
# 1. Editás código en tu PC
# 2. Desplegás:
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

## Apagar el servidor viejo (192.168.0.9)

Ya no se necesita para Libro de Guardia:

```powershell
pm2 stop bacarguard-api
pm2 delete bacarguard-api
pm2 save
```
