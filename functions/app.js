/**
 * Express app — setup global + montaje de routers por dominio.
 * La lógica de cada endpoint vive en functions/routes/*.js
 */

const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  'http://localhost:3000,https://bacarguard.web.app,https://bacarguard.firebaseapp.com'
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
app.use(require('./routes/access'));
app.use(require('./routes/fleetGps'));
app.use(require('./routes/attendance'));
app.use(require('./routes/entries'));
app.use(require('./routes/system'));

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ message: 'Ruta no encontrada' });
  }
  next();
});

module.exports = app;
