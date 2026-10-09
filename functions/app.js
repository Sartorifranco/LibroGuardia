/**
 * Express app — setup global + montaje de routers por dominio.
 * La lógica de cada endpoint vive en functions/routes/*.js
 */

const express = require('express');
const cors = require('cors');

const app = express();

/**
 * `trust proxy` para que req.ip sea la IP real y no el primer valor de
 * X-Forwarded-For (que controla el cliente).
 * Cloud Functions v2 (Cloud Run) agrega 1 salto (Google Front End). Si TODO el
 * tráfico entra por Firebase Hosting (rewrite /api/**) puede hacer falta 2.
 * TRUST_PROXY: número de saltos o lista de IPs/subredes (formato Express).
 * `true` no se acepta: confiaría en cualquier valor enviado por el cliente.
 */
const resolveTrustProxy = (raw = process.env.TRUST_PROXY) => {
  const value = String(raw ?? '').trim();
  if (!value) return 1;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'false') return false;
  if (value === 'true') {
    console.warn('[app] TRUST_PROXY=true ignorado (inseguro); se usa 1 salto.');
    return 1;
  }
  return value;
};
app.set('trust proxy', resolveTrustProxy());

const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  'http://localhost:3000,https://mss-guard.web.app,https://mss-guard.firebaseapp.com'
).split(',').map((origin) => origin.trim());

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  }
}));
app.use(express.json({ limit: '5mb' }));
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      message: 'El archivo es demasiado grande. Reduzca filas o vuelva a exportar la planilla.'
    });
  }
  return next(err);
});

// Routers por dominio (paths absolutos /api/... dentro de cada uno).
app.use(require('./routes/auth'));
app.use(require('./routes/adminUsersRoles'));
app.use(require('./routes/masterData'));
app.use(require('./routes/authorizations'));
app.use(require('./routes/accessRequests'));
app.use(require('./routes/access'));
app.use(require('./routes/empresasDestinos'));
app.use(require('./routes/lectores'));
app.use(require('./routes/estaciones'));
app.use(require('./routes/empleado'));
app.use(require('./routes/visitasAdmin'));
app.use(require('./routes/appearance'));
app.use(require('./routes/fleetGps'));
app.use(require('./routes/attendance'));
app.use(require('./routes/entries'));
app.use(require('./routes/peopleDoors'));
app.use(require('./routes/accessModel'));
app.use(require('./routes/biostar'));
app.use(require('./routes/system'));
app.use(require('./routes/edge'));

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ message: 'Ruta no encontrada' });
  }
  next();
});

module.exports = app;
