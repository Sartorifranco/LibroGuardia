'use strict';

/**
 * Punto de entrada del almacenamiento edge: abre (o recupera) la base, migra y arma
 * chunk store + journal + snapshot para el rol dado.
 */

const driver = require('./driver');
const { migrate } = require('./migrations');
const { ChunkStore } = require('./chunkStore');
const { Journal } = require('./journal');
const { SqliteSnapshot } = require('./sqliteSnapshot');

/**
 * @param {string} file
 * @param {{ role:'hub'|'controller', deviceId:string, myDoorIds?:string[]|null,
 *           verifyHead?:Function, recover?:boolean } & object} opts
 * @returns {{ db, chunks:ChunkStore, journal:Journal, snapshot:SqliteSnapshot, recovered:boolean, movedTo:string|null }}
 *   recovered=true → la base estaba corrupta y se apartó: pedir el bundle completo.
 */
function openEdgeDb(file, opts = {}) {
  const { role = 'controller', deviceId, myDoorIds = null, verifyHead = null, recover = true, ...dbOpts } = opts;
  const opened = recover ? driver.openOrRecover(file, dbOpts) : { db: driver.open(file, dbOpts), recovered: false, movedTo: null };
  const { db } = opened;
  migrate(db, { role });
  return {
    db,
    chunks: new ChunkStore(db, { role, myDoorIds, deviceId, verifyHead }),
    journal: new Journal(db, { role, deviceId }),
    snapshot: new SqliteSnapshot(db),
    recovered: opened.recovered,
    movedTo: opened.movedTo
  };
}

module.exports = {
  openEdgeDb,
  ...driver,
  ...require('./migrations'),
  ...require('./chunkStore'),
  ...require('./journal'),
  ...require('./sqliteSnapshot')
};
