const { onRequest } = require('firebase-functions/v2/https');
const app = require('./app');

exports.api = onRequest(
  {
    region: 'southamerica-east1',
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  app
);
