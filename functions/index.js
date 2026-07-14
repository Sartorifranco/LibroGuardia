const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { db, FieldValue } = require('./firestore');
const { fetchNearbyFleetAlerts } = require('./fleetGps');
const app = require('./app');

exports.api = onRequest(
  {
    region: 'southamerica-east1',
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  app
);

/** Poll UBIKA en servidor para registrar ingresos/egresos aunque ningún guardia tenga el panel abierto. */
exports.fleetGpsAutoPoll = onSchedule(
  {
    schedule: 'every 1 minutes',
    region: 'southamerica-east1',
    timeZone: 'America/Argentina/Buenos_Aires',
    timeoutSeconds: 120,
    memory: '512MiB'
  },
  async () => {
    await fetchNearbyFleetAlerts(db, FieldValue, {
      userId: 'sistema_gps',
      username: 'GPS automático'
    });
  }
);