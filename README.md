# Libro de Novedades Bacar sa.

Sistema web para registrar personal, vehículos externos, flota interna y novedades de guardia.

## Arquitectura — 100% Firebase

| Componente | Servicio |
|---|---|
| Frontend | Firebase Hosting → https://bacarguard.web.app |
| Backend | Cloud Functions → `/api/*` |
| Base de datos | **Firestore** (sin MongoDB) |

**Guía paso a paso:** [FIREBASE-SETUP.md](./FIREBASE-SETUP.md)

**Deploy:**
```powershell
.\scripts\deploy-firebase.ps1
```

---

## Flujo de trabajo (sin copiar carpetas a mano)

Hay **dos partes** que se actualizan por separado:

| Qué cambiás | Dónde se despliega | Cómo |
|---|---|---|
| Frontend (`App.js`, estilos, etc.) | Firebase | `.\scripts\deploy-frontend.ps1` |
| Backend (`server.js`, API) | Servidor `192.168.0.9` | `.\scripts\deploy-backend.ps1` |
| Ambos | — | `.\scripts\deploy-all.ps1` |

### Configuración inicial (una sola vez)

**En tu PC local:**
```powershell
cd C:\Users\Admin\Desktop\LG\scripts
copy config.example.ps1 config.ps1
# Editá config.ps1 con IP, usuario y rutas del servidor
```

**En el servidor** (ver instrucciones completas):
```powershell
.\scripts\setup-servidor.ps1   # muestra los pasos
```

Instalar **PM2** en el servidor para que la API quede siempre corriendo:
```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd C:\LG\backend-libro-guardia
pm2 start server.js --name bacarguard-api
pm2 save
```

### Uso diario — hacer cambios y publicar

1. Editás el código en tu PC (`C:\Users\Admin\Desktop\LG`)
2. Desplegás con un comando:

```powershell
# Solo frontend
.\scripts\deploy-frontend.ps1

# Solo backend
.\scripts\deploy-backend.ps1

# Todo junto
.\scripts\deploy-all.ps1
```

El script de backend **copia solo los archivos cambiados** (no `node_modules` ni `.env`) y reinicia la API con PM2.

### Opción recomendada a mediano plazo: Git + GitHub

Para tener historial de cambios y no depender de carpetas compartidas:

```powershell
# Una vez en tu PC
cd C:\Users\Admin\Desktop\LG
git init
git add .
git commit -m "Initial commit"
# Crear repo privado en GitHub y:
git remote add origin https://github.com/TU_USUARIO/libro-guardia.git
git push -u origin main

# En el servidor (una vez)
cd C:\LG
git clone https://github.com/TU_USUARIO/libro-guardia.git .
```

Después de cada cambio:
```powershell
git add .
git commit -m "Descripción del cambio"
git push

# En el servidor:
git pull
cd backend-libro-guardia && npm install
pm2 restart bacarguard-api
```

---

## Levantar en desarrollo

### Backend
```powershell
cd backend-libro-guardia
npm install
copy .env.example .env   # editar MONGODB_URI y JWT_SECRET
npm start
```

### Frontend
```powershell
cd frontend-libro-guardia
npm install
copy .env.example .env   # apuntar REACT_APP_API_BASE_URL al backend
npm start
```

## Desplegar frontend (Firebase)

```powershell
cd frontend-libro-guardia
npm run build
firebase deploy --only hosting:bacarguard
```

Proyecto Firebase: `legajosonline-959f6` · Sitio: `bacarguard`

## Desplegar backend

El backend debe correr en la PC/servidor de la red local (`192.168.0.9`) con MongoDB activo:

```powershell
cd backend-libro-guardia
npm start
```

### Crear admin sin mongosh

```powershell
cd backend-libro-guardia
node create-admin.js admin MiContraseñaSegura123
```

### Crear usuario guardia por consola (API)

```powershell
Invoke-RestMethod -Uri "http://192.168.0.9:5020/api/auth/register" -Method POST -ContentType "application/json" -Body '{"username":"guardia1","password":"MiClave123"}'
```

Requisitos:
- MongoDB corriendo (local o Atlas)
- Puerto `5020` accesible desde la red
- Variables en `.env` configuradas

## Roles de usuario

| Rol | Permisos |
|---|---|
| `guardia` | Registrar entradas, ver registros |
| `supervisor` | Todo lo anterior + gestionar usuarios guardia + flota |
| `admin` | Acceso completo |

## Endpoints principales

- `GET /api/health` — estado del servidor
- `POST /api/auth/login` · `POST /api/auth/register`
- `GET/POST /api/entries` — registros del libro
- `GET/POST /api/master-data/personal` — base maestra de personal
- `GET /api/fleet/mobiles` · `GET /api/fleet/drivers`
- `GET/POST/PUT/DELETE /api/admin/users` — gestión de usuarios
