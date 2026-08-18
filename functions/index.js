const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { db, FieldValue } = require('./firestore');
const { fetchNearbyFleetAlerts, getFleetGpsConfig } = require('./fleetGps');
const { cleanupExpiredHardwareDetectJobs } = require('./lib/hardwareDetectJobs');
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

/**
 * Borra jobs de auto-detect vencidos (pueden haber tenido password hasta el claim).
 * No requiere TTL nativo en consola; el campo expireAt también permite
 * activar TTL policy de Firestore en Firebase Console → Firestore → TTL
 * (colección hardware_detect_jobs, campo expireAt) como defensa extra.
 *
 * Aviso de costo: esta función corre cada 5 min (Scheduler + lecturas/borrados Firestore).
 */
exports.cleanupHardwareDetectJobs = onSchedule(
  {
    schedule: 'every 5 minutes',
    region: 'southamerica-east1',
    timeZone: 'America/Argentina/Buenos_Aires',
    timeoutSeconds: 60,
    memory: '256MiB'
  },
  async () => {
    const result = await cleanupExpiredHardwareDetectJobs({ limit: 200 });
    if (result.deleted > 0) {
      console.info('[cleanupHardwareDetectJobs]', result);
    }
  }
);
