const DB_NAME = 'lg-offline-queue';
const STORE = 'pending';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB no disponible'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Error abriendo IndexedDB'));
  });
}

function runRequest(mode, run) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      const req = run(store);
      req.onsuccess = () => {
        result = req.result;
      };
      req.onerror = () => {
        reject(req.error || new Error('Error IndexedDB'));
      };
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Error en transacción IndexedDB'));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error('Transacción abortada'));
    };
  }));
}

/** Encola un ítem pendiente. Retorna el id asignado. */
export async function enqueue({ type, payload, createdAt } = {}) {
  return runRequest('readwrite', (store) => store.add({
    type: type || 'entry',
    payload: payload || {},
    createdAt: createdAt || Date.now()
  }));
}

/** Lista todos los ítems pendientes (orden de inserción). */
export async function listPending() {
  const items = await runRequest('readonly', (store) => store.getAll());
  return items || [];
}

/** Elimina un ítem por id. */
export async function remove(id) {
  await runRequest('readwrite', (store) => store.delete(id));
  return true;
}

/** Cantidad de ítems pendientes. */
export async function count() {
  const n = await runRequest('readonly', (store) => store.count());
  return n || 0;
}
