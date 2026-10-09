const admin = require('firebase-admin');
const { wrapFirestore, isUsageMeterEnabled } = require('./lib/usage/meter');

if (!admin.apps.length) {
  admin.initializeApp();
}

const rawDb = admin.firestore();
const db = isUsageMeterEnabled() ? wrapFirestore(rawDb) : rawDb;

module.exports = { admin, db, FieldValue: admin.firestore.FieldValue, Timestamp: admin.firestore.Timestamp };
