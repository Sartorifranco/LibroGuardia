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
    createdAt: createdAt || Date.now(),
    status: 'pending'
  }));
}

async function listAll() {
  const items = await runRequest('readonly', (store) => store.getAll());
  return items || [];
}

/** Lista ítems que todavía se pueden enviar (no rechazados). */
export async function listPending() {
  const items = await listAll();
  return items.filter((item) => item.status !== 'rejected');
}

/** Lista ítems que el servidor rechazó y hay que mostrar al guardia. */
export async function listRejected() {
  const items = await listAll();
  return items.filter((item) => item.status === 'rejected');
}

/** Elimina un ítem por id. */
export async function remove(id) {
  await runRequest('readwrite', (store) => store.delete(id));
  return true;
}

/**
 * Actualiza un ítem. El mutador recibe el registro actual y devuelve el nuevo.
 */
export function updateItem(id, mutator) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let next = null;
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const item = getReq.result;
      if (!item) return;
      next = mutator(item);
      const putReq = store.put(next);
      putReq.onerror = () => reject(putReq.error || new Error('Error al actualizar la cola'));
    };
    getReq.onerror = () => reject(getReq.error || new Error('Error al leer la cola'));
    tx.oncomplete = () => {
      db.close();
      resolve(next);
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

/** Marca un ítem como rechazado por el servidor, sin borrarlo. */
export function markRejected(id, reason) {
  const rejectReason = String(reason || 'El servidor no aceptó el registro').trim();
  return updateItem(id, (item) => ({
    ...item,
    status: 'rejected',
    rejectReason,
    rejectedAt: Date.now()
  }));
}

/** Vuelve a dejar un ítem rechazado listo para enviar. */
export function markPending(id) {
  return updateItem(id, (item) => ({
    ...item,
    status: 'pending',
    rejectReason: '',
    rejectedAt: null
  }));
}

/** Cantidad de ítems que todavía se pueden enviar (los rechazados no cuentan). */
export async function count() {
  const items = await listPending();
  return items.length;
}

const TYPE_LABELS = {
  personal: 'Personal',
  vehiculo: 'Vehículo',
  flota: 'Flota',
  novedad: 'Novedad'
};

/** Texto corto para mostrar un ítem de la cola al guardia. */
export function describeQueuedItem(item = {}) {
  const payload = item.payload || {};
  const type = payload.type || item.type;
  const label = TYPE_LABELS[type] || 'Registro';
  const key = payload.name
    || payload.plate
    || payload.mobile
    || payload.idNumber
    || (payload.description ? String(payload.description).slice(0, 40) : '');
  return { label, key: key ? String(key) : '' };
}
