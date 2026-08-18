const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { db, FieldValue } = require('./firestore');
const { fetchNearbyFleetAlerts, getFleetGpsConfig } = require('./fleetGps');
const app = require('./app');

exports.api = onRequest(
  {
    region: 'southamerica-east1',
    timeoutSeconds: 300,
    memory: '1GiB',
  },
  app
);

/**
 * Única consulta real a UBIKA (cada 5 min).
 * Registra ingresos/egresos aunque nadie mire el panel.
 * Las pantallas leen la foto guardada (casi sin costo).
 */
exports.fleetGpsAutoPoll = onSchedule(
  {
    schedule: 'every 5 minutes',
    region: 'southamerica-east1',
    timeZone: 'America/Argentina/Buenos_Aires',
    timeoutSeconds: 120,
    memory: '256MiB'
  },
  async () => {
    const config = await getFleetGpsConfig(db);
    if (!config.enabled) return;

    await fetchNearbyFleetAlerts(db, FieldValue, {
      userId: 'sistema_gps',
      username: 'GPS automático',
      forceUbika: true,
      preferCache: false
    });
  }
);
