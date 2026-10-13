const DEFAULT_FLEET_GPS = {
  enabled: false,
  provider: 'ubika',
  apiUrl: process.env.UBIKA_API_URL || 'https://ubika.rastreo.com.ar',
  apiKey: process.env.UBIKA_API_TOKEN || '',
  guardiaLat: null,
  guardiaLng: null,
  /** circle | polygon */
  geofenceMode: 'circle',
  /** Portones dibujados en mapa (hasta 4). */
  gatePolygons: [],
  /** Perímetro de planta opcional cuando geofenceMode = polygon. */
  plantPolygon: null,
  /** Radio del portón: solo tránsito entrando/saliendo. */
  gateRadiusMeters: 45,
  /** Radio de planta: distingue “adentro” vs “afuera”. */
  plantRadiusMeters: 400,
  /** Compat: si existe alertRadiusMeters viejo, se usa como gate. */
  alertRadiusMeters: 45,
  /** Velocidad mínima (nudos Traccar/UBIKA) para considerar movimiento. */
  minSpeedKnots: 1,
  requireMotion: true,
  autoRegisterMovements: true,
  movementCooldownSeconds: 300,
  /** Cada cuántos segundos refresca la pantalla del guardia/mapa (lee caché, no UBIKA). */
  pollIntervalSeconds: 60,
  /**
   * Cada cuántos minutos el servidor consulta UBIKA y registra ingresos/egresos.
   * Es el costo principal: bajarlo reduce factura; 5 min alcanza para portón.
   */
  cloudSyncIntervalMinutes: 5,
  /** Alerta visual al guardia cuando un móvil se acerca a planta. */
  approachAlertEnabled: false,
  approachRadiusMeters: 400,
  approachRequireMotion: true,
  lastError: null,
  lastSyncAt: null
};

const crypto = require('crypto');
const { loadTrackMap, saveTrackMap, trackNeedsWrite } = require('./lib/fleetGpsStore');

const API_KEY_MASK = '********';
const SNAPSHOT_DOC = 'fleetGpsSnapshot';
const LOOKUP_TTL_MS = 10 * 60 * 1000;
const {
  sanitizeGatePolygons,
  persistGatePolygons,
  formatGatePolygonsForApi,
  sanitizePlantPolygon,
  persistPlantPolygon,
  formatPlantPolygonForApi,
  normalizePolygonPoints,
  usesPolygonGeofence,
  resolveVehicleGeofence
} = require('./lib/geofence');
const {
  getGpsProvider,
  fetchFleetFromProvider,
  extractPlate,
  extractVehicleLabel,
  gpsEntrySourceForProvider
} = require('./lib/gpsProviders');

const toRadians = (value) => (value * Math.PI) / 180;

const distanceMeters = (lat1, lng1, lat2, lng2) => {
  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const normalizeFleetToken = (value = '') =>
  String(value || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]/g, '');

const resolveApiKey = (config) => {
  const provider = getGpsProvider(config?.provider);
  return provider.resolveCredentials(config).apiKey || '';
};

const serializeTimestamp = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value._seconds === 'number') return new Date(value._seconds * 1000).toISOString();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString();
  return value;
};

const resolveGateRadius = (config) => {
  const gate = Number(config.gateRadiusMeters);
  if (!Number.isNaN(gate) && gate > 0) return gate;
  const legacy = Number(config.alertRadiusMeters);
  if (!Number.isNaN(legacy) && legacy > 0) return legacy;
  return DEFAULT_FLEET_GPS.gateRadiusMeters;
};

const resolvePlantRadius = (config) => {
  const plant = Number(config.plantRadiusMeters);
  const gate = resolveGateRadius(config);
  if (!Number.isNaN(plant) && plant > gate) return plant;
  return Math.max(gate * 6, DEFAULT_FLEET_GPS.plantRadiusMeters);
};

const publicFleetGpsConfig = (config) => {
  const provider = getGpsProvider(config.provider);
  return {
    ...config,
    provider: provider.id,
    providerDisplayName: provider.displayName,
    apiKey: config.apiKey ? API_KEY_MASK : '',
    hasApiKey: Boolean(resolveApiKey(config)),
    geofenceMode: config.geofenceMode === 'polygon' ? 'polygon' : 'circle',
    gatePolygons: formatGatePolygonsForApi(config.gatePolygons),
    activeGatePolygons: sanitizeGatePolygons(config.gatePolygons).map((gate) => ({
      ...gate,
      points: normalizePolygonPoints(gate.points)
    })),
    plantPolygon: formatPlantPolygonForApi(config.plantPolygon),
    usesPolygonGeofence: usesPolygonGeofence(config),
    gateRadiusMeters: resolveGateRadius(config),
    plantRadiusMeters: resolvePlantRadius(config),
    alertRadiusMeters: resolveGateRadius(config),
    lastSyncAt: serializeTimestamp(config.lastSyncAt),
    updatedAt: serializeTimestamp(config.updatedAt)
  };
};

const parseOptionalNumber = (value) => {
  if (value === null || value === '') return null;
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isNaN(num) ? undefined : num;
};

/** Corrige coordenadas guardadas sin punto decimal (ej. -64176830 → -64.176830). */
const normalizeGeoCoordinate = (value, axis = 'lng') => {
  if (value == null || value === '') return value;
  const num = Number(value);
  if (Number.isNaN(num)) return value;

  const limit = axis === 'lat' ? 90 : 180;
  if (Math.abs(num) <= limit) return num;

  const sign = num < 0 ? -1 : 1;
  const digits = String(Math.abs(Math.trunc(num)));
  const head = axis === 'lat' ? 2 : 2;
  if (digits.length >= head + 4) {
    const fixed = sign * Number(`${digits.slice(0, head)}.${digits.slice(head)}`);
    if (!Number.isNaN(fixed) && Math.abs(fixed) <= limit) return fixed;
  }
  return num;
};

const normalizeFleetGpsConfig = (config = {}) => {
  const next = { ...config };
  if (next.guardiaLat != null) next.guardiaLat = normalizeGeoCoordinate(next.guardiaLat, 'lat');
  if (next.guardiaLng != null) next.guardiaLng = normalizeGeoCoordinate(next.guardiaLng, 'lng');
  return next;
};

const getFleetGpsConfig = async (db) => {
  const snap = await db.collection('settings').doc('fleetGps').get();
  const stored = snap.exists ? snap.data() : {};
  const merged = { ...DEFAULT_FLEET_GPS, ...stored };
  const credentials = getGpsProvider(merged.provider).resolveCredentials(merged);
  if (!merged.apiKey) {
    merged.apiKey = credentials.apiKey || '';
  }
  if (!merged.apiUrl) {
    merged.apiUrl = credentials.apiUrl || DEFAULT_FLEET_GPS.apiUrl;
  }
  // Migración: configs viejas con radio grande (planta) → portón chico
  if (stored.gateRadiusMeters == null && Number(stored.alertRadiusMeters) > 80) {
    merged.gateRadiusMeters = DEFAULT_FLEET_GPS.gateRadiusMeters;
    merged.plantRadiusMeters = Math.max(Number(stored.alertRadiusMeters), DEFAULT_FLEET_GPS.plantRadiusMeters);
  }
  const normalized = normalizeFleetGpsConfig(merged);
  if (snap.exists) {
    const needsRepair = (
      (stored.guardiaLat != null && Number(stored.guardiaLat) !== normalized.guardiaLat)
      || (stored.guardiaLng != null && Number(stored.guardiaLng) !== normalized.guardiaLng)
    );
    if (needsRepair) {
      await db.collection('settings').doc('fleetGps').set({
        guardiaLat: normalized.guardiaLat,
        guardiaLng: normalized.guardiaLng,
        updatedAt: new Date()
      }, { merge: true });
    }
  }
  return normalized;
};

const sanitizeFleetGpsUpdates = (body = {}) => {
  const updates = {};

  if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;
  if (typeof body.provider === 'string' && body.provider.trim()) {
    updates.provider = body.provider.trim();
  }
  if (typeof body.apiUrl === 'string' && body.apiUrl.trim()) {
    updates.apiUrl = body.apiUrl.trim().replace(/\/$/, '');
  }
  if (typeof body.apiKey === 'string'
    && body.apiKey.trim()
    && body.apiKey.trim() !== API_KEY_MASK) {
    updates.apiKey = body.apiKey.trim();
  }
  if (typeof body.requireMotion === 'boolean') updates.requireMotion = body.requireMotion;
  if (typeof body.autoRegisterMovements === 'boolean') {
    updates.autoRegisterMovements = body.autoRegisterMovements;
  }

  const guardiaLat = parseOptionalNumber(body.guardiaLat);
  if (guardiaLat !== undefined) updates.guardiaLat = normalizeGeoCoordinate(guardiaLat, 'lat');
  const guardiaLng = parseOptionalNumber(body.guardiaLng);
  if (guardiaLng !== undefined) updates.guardiaLng = normalizeGeoCoordinate(guardiaLng, 'lng');

  const gateRadius = parseOptionalNumber(body.gateRadiusMeters ?? body.alertRadiusMeters);
  if (gateRadius != null && gateRadius > 0) {
    updates.gateRadiusMeters = gateRadius;
    updates.alertRadiusMeters = gateRadius;
  }

  const plantRadius = parseOptionalNumber(body.plantRadiusMeters);
  if (plantRadius != null && plantRadius > 0) updates.plantRadiusMeters = plantRadius;

  if (typeof body.geofenceMode === 'string') {
    updates.geofenceMode = body.geofenceMode === 'polygon' ? 'polygon' : 'circle';
  }
  if (Array.isArray(body.gatePolygons)) {
    updates.gatePolygons = persistGatePolygons(body.gatePolygons);
  }
  if (body.plantPolygon === null) {
    updates.plantPolygon = null;
  } else if (body.plantPolygon && typeof body.plantPolygon === 'object') {
    const plant = persistPlantPolygon(body.plantPolygon);
    if (plant) updates.plantPolygon = plant;
  }

  if (typeof body.approachAlertEnabled === 'boolean') {
    updates.approachAlertEnabled = body.approachAlertEnabled;
  }
  const approachRadius = parseOptionalNumber(body.approachRadiusMeters);
  if (approachRadius != null && approachRadius > 0) {
    updates.approachRadiusMeters = approachRadius;
  }
  if (typeof body.approachRequireMotion === 'boolean') {
    updates.approachRequireMotion = body.approachRequireMotion;
  }

  const minSpeed = parseOptionalNumber(body.minSpeedKnots);
  if (minSpeed != null && minSpeed >= 0) updates.minSpeedKnots = minSpeed;

  const cooldown = parseOptionalNumber(body.movementCooldownSeconds);
  if (cooldown != null && cooldown >= 60) updates.movementCooldownSeconds = cooldown;

  const poll = parseOptionalNumber(body.pollIntervalSeconds);
  if (poll != null && poll >= 30) updates.pollIntervalSeconds = poll;

  const cloudSync = parseOptionalNumber(body.cloudSyncIntervalMinutes);
  if (cloudSync != null && cloudSync >= 2 && cloudSync <= 30) {
    updates.cloudSyncIntervalMinutes = Math.round(cloudSync);
  }

  return updates;
};

const stripUndefined = (value = {}) => Object.fromEntries(
  Object.entries(value).filter(([, entry]) => entry !== undefined)
);

const saveFleetGpsConfig = async (db, FieldValue, body) => {
  const updates = stripUndefined(sanitizeFleetGpsUpdates(body));
  await db.collection('settings').doc('fleetGps').set({
    ...updates,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return getFleetGpsConfig(db);
};

const saveFleetGpsGeofence = async (db, FieldValue, body = {}) => {
  const updates = {};

  if (typeof body.geofenceMode === 'string') {
    updates.geofenceMode = body.geofenceMode === 'polygon' ? 'polygon' : 'circle';
  }
  if (Array.isArray(body.gatePolygons)) {
    updates.gatePolygons = persistGatePolygons(body.gatePolygons);
  }
  if (body.plantPolygon === null) {
    updates.plantPolygon = null;
  } else if (body.plantPolygon && typeof body.plantPolygon === 'object') {
    const plant = persistPlantPolygon(body.plantPolygon);
    if (plant) updates.plantPolygon = plant;
  }

  const guardiaLat = parseOptionalNumber(body.guardiaLat);
  if (guardiaLat !== undefined) updates.guardiaLat = normalizeGeoCoordinate(guardiaLat, 'lat');
  const guardiaLng = parseOptionalNumber(body.guardiaLng);
  if (guardiaLng !== undefined) updates.guardiaLng = normalizeGeoCoordinate(guardiaLng, 'lng');

  if (!Object.keys(updates).length) {
    throw new Error('No hay cambios de geocerca para guardar');
  }

  await db.collection('settings').doc('fleetGps').set({
    ...stripUndefined(updates),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return getFleetGpsConfig(db);
};

/** Retrocompat: UBIKA sigue siendo el único proveedor en producción. */
const fetchUbikaFleet = async (config) => getGpsProvider('ubika').fetchFleet(config);

const resolveZone = (distance, gateRadius, plantRadius) => {
  if (distance == null) return 'unknown';
  if (distance <= gateRadius) return 'gate';
  if (distance <= plantRadius) return 'plant';
  return 'outside';
};

const isVehicleMoving = (vehicle, config) => {
  const minSpeed = Number(config.minSpeedKnots);
  const speedOk = !Number.isNaN(minSpeed) && vehicle.speed >= minSpeed;
  if (config.requireMotion === false) return speedOk || vehicle.motion || vehicle.ignition;
  return vehicle.motion || speedOk;
};

const withDistanceAndZone = (vehicles, config) => {
  const guardiaLat = Number(config.guardiaLat);
  const guardiaLng = Number(config.guardiaLng);
  const hasCenter = !Number.isNaN(guardiaLat) && !Number.isNaN(guardiaLng);

  return vehicles
    .map((vehicle) => {
      const geofence = resolveVehicleGeofence(vehicle.lat, vehicle.lng, config, distanceMeters);
      const centerDistanceMeters = hasCenter
        ? Math.round(distanceMeters(guardiaLat, guardiaLng, vehicle.lat, vehicle.lng))
        : null;
      return {
        ...vehicle,
        distanceMeters: geofence.distanceMeters,
        centerDistanceMeters,
        zone: geofence.zone,
        gateId: geofence.gateId || null,
        gateName: geofence.gateName || null,
        moving: isVehicleMoving(vehicle, config)
      };
    })
    .sort((a, b) => (a.distanceMeters ?? Number.POSITIVE_INFINITY) - (b.distanceMeters ?? Number.POSITIVE_INFINITY));
};

const detectApproachingVehicles = (vehicles = [], config = {}) => {
  if (!config.approachAlertEnabled) return [];

  const approachRadius = Number(config.approachRadiusMeters) || 400;
  const requireMotion = config.approachRequireMotion !== false;

  return vehicles
    .filter((vehicle) => {
      if (vehicle.zone === 'gate' || vehicle.zone === 'plant') return false;
      if (requireMotion && !vehicle.moving) return false;
      const centerDistance = vehicle.centerDistanceMeters;
      return centerDistance != null && centerDistance <= approachRadius;
    })
    .sort((a, b) => (a.centerDistanceMeters ?? 99999) - (b.centerDistanceMeters ?? 99999))
    .map((vehicle) => ({
      ...vehicle,
      alertType: 'approaching',
      approachLabel: `Llegando (${vehicle.centerDistanceMeters} m)`
    }));
};

let mobilesCache = { loadedAt: 0, rows: null };
let vehiclesCache = { loadedAt: 0, byPlate: null };

const invalidateFleetLookupCache = () => {
  mobilesCache = { loadedAt: 0, rows: null };
  vehiclesCache = { loadedAt: 0, byPlate: null };
};

const cacheFresh = (loadedAt) => loadedAt && (Date.now() - loadedAt) < LOOKUP_TTL_MS;

const getMobilesCached = async (db) => {
  if (cacheFresh(mobilesCache.loadedAt) && mobilesCache.rows) return mobilesCache.rows;
  const snap = await db.collection('mobiles').get();
  const rows = (snap.docs || []).map((doc) => ({
    id: doc.id,
    name: doc.data()?.name || ''
  }));
  mobilesCache = { loadedAt: Date.now(), rows };
  return rows;
};

const getVehiclesByPlateCached = async (db) => {
  if (cacheFresh(vehiclesCache.loadedAt) && vehiclesCache.byPlate) return vehiclesCache.byPlate;
  const snap = await db.collection('vehiclesMaster').get();
  const byPlate = new Map();
  (snap.docs || []).forEach((doc) => {
    const data = doc.data() || {};
    const plate = String(data.plateNormalized || '').toUpperCase();
    if (plate) byPlate.set(plate, { id: doc.id, ...data });
  });
  vehiclesCache = { loadedAt: Date.now(), byPlate };
  return byPlate;
};

const warmFleetLookupCache = async (db) => {
  await Promise.all([getMobilesCached(db), getVehiclesByPlateCached(db)]);
};

const lookupVehicleMaster = async (db, plate) => {
  if (!plate) return null;
  const byPlate = await getVehiclesByPlateCached(db);
  return byPlate.get(String(plate).toUpperCase()) || null;
};

const lookupFleetMobile = async (db, vehicle = {}) => {
  const rows = await getMobilesCached(db);
  if (!rows.length) return null;

  const label = extractVehicleLabel(vehicle.name, vehicle.plate);
  const searchTokens = [...new Set([
    normalizeFleetToken(label),
    normalizeFleetToken(vehicle.name),
    normalizeFleetToken(vehicle.plate)
  ].filter((token) => token.length >= 3))];

  if (!searchTokens.length) return null;

  let best = null;
  let bestScore = 0;

  rows.forEach((row) => {
    const mobileName = row.name || '';
    const mobileToken = normalizeFleetToken(mobileName);
    if (!mobileToken) return;

    searchTokens.forEach((token) => {
      let score = 0;
      if (mobileToken === token) score = 100;
      else if (mobileToken.includes(token) || token.includes(mobileToken)) score = 70;
      else if (mobileName.toLowerCase().includes(label.toLowerCase().slice(0, 6))) score = 40;

      if (score > bestScore) {
        bestScore = score;
        best = { id: row.id, name: mobileName };
      }
    });
  });

  return bestScore >= 40 ? best : null;
};

const resolveGpsVehicleDetails = async (db, vehicle = {}) => {
  const plate = vehicle.plate || extractPlate(vehicle.name) || '';
  const vehicleLabel = extractVehicleLabel(vehicle.name, plate);
  const [master, mobile] = await Promise.all([
    lookupVehicleMaster(db, plate),
    lookupFleetMobile(db, { ...vehicle, plate })
  ]);

  const brand = master?.brand || mobile?.name || vehicleLabel;
  const driver = master?.driver || '';
  const company = master?.company || 'Flota interna';

  return {
    plate: plate || vehicle.name,
    brand,
    driver,
    company,
    mobileName: mobile?.name || vehicleLabel,
    vehicleLabel,
    master,
    mobile
  };
};

const withinCooldown = (track, movementType, cooldownSeconds) => {
  if (!track?.lastMovementAt || track.lastMovementType !== movementType) return false;
  const lastAt = track.lastMovementAt?.toDate
    ? track.lastMovementAt.toDate()
    : new Date(track.lastMovementAt);
  if (Number.isNaN(lastAt.getTime())) return false;
  return (Date.now() - lastAt.getTime()) < cooldownSeconds * 1000;
};

/** Detecta ingreso/egreso comparando zona previa vs actual (tolerante a polls que saltan el polígono de portón). */
const resolveTransitDirection = (vehicle, prev) => {
  const prevZone = prev?.zone ?? null;

  if (!vehicle.moving) {
    return vehicle.zone === 'gate' && prev?.pendingDirection ? prev.pendingDirection : null;
  }

  if (!prevZone) return null;

  if (prevZone === vehicle.zone) {
    return vehicle.zone === 'gate' && prev?.pendingDirection ? prev.pendingDirection : null;
  }

  const transitionKey = `${prevZone}->${vehicle.zone}`;
  const transitions = {
    'outside->gate': 'ingreso',
    'outside->plant': 'ingreso',
    'gate->plant': 'ingreso',
    'plant->gate': 'egreso',
    'plant->outside': 'egreso',
    'gate->outside': 'egreso'
  };

  return transitions[transitionKey] || null;
};

/**
 * Hora del movimiento para el libro:
 * prioriza la hora del GPS (fixTime/deviceTime de UBIKA).
 * Si no viene, usa el momento en que el servidor lo detectó.
 */
const resolveGpsEventTimeIso = (vehicle = {}, fallbackIso = null) => {
  const raw = vehicle.fixTime || vehicle.deviceTime || null;
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      // Evitar futuros absurdos (> 2 min) por reloj desfasado del equipo.
      const maxFutureMs = Date.now() + 2 * 60 * 1000;
      if (parsed.getTime() <= maxFutureMs) {
        return parsed.toISOString();
      }
    }
  }
  return fallbackIso || new Date().toISOString();
};

const registerGpsMovement = async (db, FieldValue, vehicle, movementType, meta = {}) => {
  const details = await resolveGpsVehicleDetails(db, vehicle);
  const detectedAt = new Date().toISOString();
  const eventTime = resolveGpsEventTimeIso(vehicle, detectedAt);
  const usedGpsClock = eventTime !== detectedAt
    || Boolean(vehicle.fixTime || vehicle.deviceTime);
  const provider = getGpsProvider(meta.providerId);
  const providerLabel = provider.displayName || provider.id;

  const entryData = {
    type: 'flota',
    movementType,
    mobile: details.mobileName,
    flotaDriver: details.driver || 'Sin chofer (GPS)',
    plate: details.plate,
    scheduledTime: null,
    // Hora operativa del libro = hora GPS del cruce (no la del poll cada 5 min).
    actualTime: eventTime,
    eventTime,
    gpsFixTime: vehicle.fixTime || vehicle.deviceTime || null,
    gpsDetectedAt: detectedAt,
    gpsVehicleLabel: details.vehicleLabel,
    authorized: details.master ? details.master.authorized !== false : true,
    authorizedStatus: details.master
      ? (details.master.authorized === false ? 'not_authorized' : 'authorized')
      : 'gps_fleet',
    entrySource: provider.id === 'ubika' ? 'gps_ubika' : gpsEntrySourceForProvider(provider.id),
    gpsAuto: true,
    gpsDeviceId: vehicle.deviceId,
    gpsName: vehicle.name,
    gpsDistanceMeters: vehicle.distanceMeters,
    gpsSpeed: vehicle.speed,
    registeredBy: meta.userId || 'sistema_gps',
    registeredByUsername: meta.username || 'GPS automático',
    timestamp: FieldValue.serverTimestamp(),
    notes: `Movimiento GPS ${providerLabel} (${movementType}) — ${vehicle.name}${vehicle.gateName ? ` · ${vehicle.gateName}` : ''}${usedGpsClock ? ' · hora GPS' : ' · hora detección'}`
  };

  const ref = await db.collection('entries').add(entryData);
  return { entryId: ref.id, entry: entryData, master: details.master };
};

const processTransit = async (db, FieldValue, vehicles, config, options = {}) => {
  const cooldown = Number(config.movementCooldownSeconds) || DEFAULT_FLEET_GPS.movementCooldownSeconds;
  const autoRegister = config.autoRegisterMovements !== false && !options.skipAutoRegister;
  const loaded = await loadTrackMap(db);
  const tracks = loaded.map;
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  const transit = [];
  const registered = [];
  let dirty = false;

  for (const vehicle of vehicles) {
    const trackKey = String(vehicle.deviceId);
    const prev = tracks.get(trackKey);
    const direction = resolveTransitDirection(vehicle, prev);

    const trackUpdate = {
      deviceId: vehicle.deviceId,
      name: vehicle.name,
      plate: vehicle.plate,
      zone: vehicle.zone,
      distanceMeters: vehicle.distanceMeters,
      lat: vehicle.lat,
      lng: vehicle.lng,
      speed: vehicle.speed,
      motion: vehicle.motion,
      ignition: vehicle.ignition,
      status: vehicle.status,
      moving: Boolean(vehicle.moving),
      pendingDirection: prev?.pendingDirection || null,
      lastMovementType: prev?.lastMovementType || null,
      lastMovementAt: prev?.lastMovementAt || null,
      lastEntryId: prev?.lastEntryId || null,
      lastWrittenAt: prev?.lastWrittenAt || null,
      lastSeenAt: prev?.lastSeenAt || null
    };
    let movementLogged = false;

    if (direction) {
      const cooled = withinCooldown(prev, direction, cooldown);
      const item = {
        ...vehicle,
        direction,
        directionLabel: direction === 'ingreso' ? 'Entrando' : 'Saliendo',
        pending: !autoRegister || cooled
      };

      if (autoRegister && !cooled) {
        try {
          const result = await registerGpsMovement(db, FieldValue, vehicle, direction, {
            ...options,
            username: options.username,
            providerId: config.provider
          });
          item.entryId = result.entryId;
          item.registered = true;
          item.pending = false;
          trackUpdate.lastMovementType = direction;
          trackUpdate.lastMovementAt = nowIso;
          trackUpdate.lastEntryId = result.entryId;
          trackUpdate.pendingDirection = null;
          movementLogged = true;
          registered.push(item);
        } catch (err) {
          item.registered = false;
          item.registerError = err.message;
          trackUpdate.pendingDirection = direction;
        }
      } else {
        trackUpdate.pendingDirection = cooled ? null : direction;
        if (cooled) item.cooldown = true;
      }

      transit.push(item);
    } else if (vehicle.zone !== 'gate') {
      trackUpdate.pendingDirection = null;
    }

    if (trackNeedsWrite(prev, { ...trackUpdate, movementLogged }, nowMs)) {
      trackUpdate.lastWrittenAt = nowIso;
      trackUpdate.lastSeenAt = nowIso;
      tracks.set(trackKey, trackUpdate);
      dirty = true;
    }
  }

  if (dirty) await saveTrackMap(db, tracks, loaded.shardCount);

  return { transit, registered };
};

const resolveCloudSyncIntervalMs = (config = {}) => {
  const minutes = Number(config.cloudSyncIntervalMinutes);
  const safe = Number.isFinite(minutes) && minutes >= 2
    ? Math.min(30, Math.round(minutes))
    : DEFAULT_FLEET_GPS.cloudSyncIntervalMinutes;
  return safe * 60 * 1000;
};

const readFleetGpsSnapshot = async (db) => {
  const snap = await db.collection('settings').doc(SNAPSHOT_DOC).get();
  if (!snap.exists) return null;
  return snap.data() || null;
};

const isSnapshotFresh = (snapshot, config) => {
  if (!snapshot?.syncedAt) return false;
  const syncedMs = new Date(snapshot.syncedAt).getTime();
  if (Number.isNaN(syncedMs)) return false;
  return (Date.now() - syncedMs) < resolveCloudSyncIntervalMs(config);
};

const buildAlertsPayloadFromSnapshot = (snapshot, config) => {
  const gateRadius = resolveGateRadius(config);
  const plantRadius = resolvePlantRadius(config);
  return {
    alerts: snapshot.transit || [],
    transit: snapshot.transit || [],
    approaching: snapshot.approaching || [],
    registered: snapshot.registered || [],
    atGateStopped: snapshot.atGateStopped || [],
    inPlant: snapshot.inPlant || [],
    nearest: snapshot.nearest || [],
    config: publicFleetGpsConfig({
      ...config,
      lastSyncAt: snapshot.syncedAt || config.lastSyncAt,
      lastError: null
    }),
    vehicleCount: snapshot.vehicleCount || 0,
    gateRadiusMeters: snapshot.gateRadiusMeters || gateRadius,
    plantRadiusMeters: snapshot.plantRadiusMeters || plantRadius,
    approachRadiusMeters: Number(config.approachRadiusMeters) || 400,
    message: snapshot.message || 'Datos GPS en caché',
    fromCache: true,
    syncedAt: snapshot.syncedAt || null
  };
};

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

const snapshotFingerprint = (payload) => {
  const round = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return null;
    return Math.round(x * 10000) / 10000;
  };
  const ids = (list) => (list || []).map((item) => String(item.deviceId || item.id || '')).sort();
  return crypto.createHash('sha1').update(stableStringify({
    vehicleCount: payload.vehicleCount || 0,
    message: payload.message || '',
    summary: payload.summary || null,
    gateRadiusMeters: payload.gateRadiusMeters || null,
    plantRadiusMeters: payload.plantRadiusMeters || null,
    guardiaLat: payload.guardiaLat ?? null,
    guardiaLng: payload.guardiaLng ?? null,
    transit: (payload.transit || []).map((item) => `${item.deviceId}:${item.direction}:${item.registered ? 1 : 0}:${item.zone}`).sort(),
    registered: (payload.registered || []).map((item) => `${item.deviceId}:${item.entryId || ''}`).sort(),
    approaching: ids(payload.approaching),
    atGateStopped: ids(payload.atGateStopped),
    inPlant: ids(payload.inPlant),
    vehicles: (payload.vehicles || []).map((item) => ({
      id: String(item.deviceId),
      zone: item.zone || null,
      moving: Boolean(item.moving),
      lat: round(item.lat),
      lng: round(item.lng),
      speed: Math.round(Number(item.speed) || 0)
    })).sort((a, b) => a.id.localeCompare(b.id))
  })).digest('hex');
};

const persistFleetGpsSnapshot = async (db, FieldValue, payload) => {
  const vehicles = Array.isArray(payload.vehicles) ? payload.vehicles : [];
  const contentHash = snapshotFingerprint(payload);
  const ref = db.collection('settings').doc(SNAPSHOT_DOC);
  const prev = await ref.get();
  const previous = prev.exists ? (prev.data() || {}) : null;
  if (previous && previous.contentHash === contentHash) return false;

  await ref.set({
    syncedAt: payload.syncedAt,
    message: payload.message || '',
    vehicleCount: payload.vehicleCount || vehicles.length,
    transit: payload.transit || [],
    approaching: payload.approaching || [],
    registered: payload.registered || [],
    atGateStopped: payload.atGateStopped || [],
    inPlant: payload.inPlant || [],
    nearest: payload.nearest || [],
    vehicles,
    summary: payload.summary || null,
    gateRadiusMeters: payload.gateRadiusMeters || null,
    plantRadiusMeters: payload.plantRadiusMeters || null,
    guardiaLat: payload.guardiaLat ?? null,
    guardiaLng: payload.guardiaLng ?? null,
    contentHash,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return true;
};

const fetchNearbyFleetAlerts = async (db, FieldValue, options = {}) => {
  const config = options.config || await getFleetGpsConfig(db);
  const force = Boolean(options.force);
  const forceUbika = Boolean(options.forceUbika) || force;
  const preferCache = options.preferCache !== false && !forceUbika;

  if (!config.enabled && !force) {
    return {
      alerts: [],
      transit: [],
      nearest: [],
      inPlant: [],
      registered: [],
      config: publicFleetGpsConfig(config),
      message: 'GPS de flota deshabilitado',
      fromCache: false
    };
  }

  if (!resolveApiKey(config)) {
    const missing = getGpsProvider(config.provider).missingConfigMessage;
    return {
      alerts: [],
      transit: [],
      nearest: [],
      inPlant: [],
      registered: [],
      config: publicFleetGpsConfig(config),
      message: missing,
      error: missing,
      fromCache: false
    };
  }

  if (config.guardiaLat == null || config.guardiaLng == null) {
    return {
      alerts: [],
      transit: [],
      nearest: [],
      inPlant: [],
      registered: [],
      config: publicFleetGpsConfig(config),
      message: 'Configure las coordenadas de la guardia',
      error: 'Configure las coordenadas de la guardia',
      fromCache: false
    };
  }

  if (preferCache) {
    const snapshot = await readFleetGpsSnapshot(db);
    if (snapshot?.syncedAt) {
      const payload = buildAlertsPayloadFromSnapshot(snapshot, config);
      if (!isSnapshotFresh(snapshot, config)) {
        payload.message = `${payload.message} · última sync (próxima automática en minutos)`;
        payload.stale = true;
      }
      return payload;
    }
    return {
      alerts: [],
      transit: [],
      nearest: [],
      inPlant: [],
      registered: [],
      config: publicFleetGpsConfig(config),
      message: 'Aún no hay sync GPS. El servidor actualiza solo cada pocos minutos.',
      fromCache: true,
      stale: true
    };
  }

  try {
    const rawVehicles = Array.isArray(options.vehicles)
      ? options.vehicles
      : await fetchFleetFromProvider(config);
    const vehicles = withDistanceAndZone(rawVehicles, config);
    const gateRadius = resolveGateRadius(config);
    const plantRadius = resolvePlantRadius(config);
    const approaching = detectApproachingVehicles(vehicles, config);

    const { transit, registered } = await processTransit(db, FieldValue, vehicles, config, options);

    const inPlantParked = vehicles.filter((v) => v.zone === 'plant' && !v.moving);
    const atGateStopped = vehicles.filter((v) => v.zone === 'gate' && !v.moving);
    const nearest = vehicles.slice(0, 15);

    if ((config.lastError || null) !== null) {
      await db.collection('settings').doc('fleetGps').set({
        lastSyncAt: FieldValue.serverTimestamp(),
        lastError: null
      }, { merge: true });
    }

    const syncedAt = new Date().toISOString();
    const approachSuffix = approaching.length
      ? ` · ${approaching.length} acercándose a planta`
      : '';
    const message = transit.length
      ? `${transit.length} móvil(es) en tránsito por el portón${approachSuffix}`
      : `Sin tránsito en portón (${inPlantParked.length} estacionados en planta, ${vehicles.length} en flota)${approachSuffix}`;

    const summary = {
      moving: vehicles.filter((v) => v.moving).length,
      stopped: vehicles.filter((v) => !v.moving).length,
      atGate: vehicles.filter((v) => v.zone === 'gate').length,
      inPlant: vehicles.filter((v) => v.zone === 'plant').length,
      outside: vehicles.filter((v) => v.zone === 'outside').length
    };

    const payload = {
      alerts: transit,
      transit,
      approaching,
      registered,
      atGateStopped,
      inPlant: inPlantParked.slice(0, 20),
      nearest,
      vehicles,
      summary,
      config: publicFleetGpsConfig({ ...config, lastSyncAt: syncedAt, lastError: null }),
      vehicleCount: vehicles.length,
      gateRadiusMeters: gateRadius,
      plantRadiusMeters: plantRadius,
      approachRadiusMeters: Number(config.approachRadiusMeters) || 400,
      guardiaLat: config.guardiaLat,
      guardiaLng: config.guardiaLng,
      message,
      syncedAt,
      fromCache: false
    };

    await persistFleetGpsSnapshot(db, FieldValue, payload);
    return payload;
  } catch (err) {
    if ((config.lastError || null) !== (err.message || null)) {
      await db.collection('settings').doc('fleetGps').set({
        lastError: err.message,
        lastSyncAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    // Si UBIKA falla, devolver última foto si hay (mejor que panel vacío).
    const snapshot = await readFleetGpsSnapshot(db);
    if (snapshot?.syncedAt) {
      return {
        ...buildAlertsPayloadFromSnapshot(snapshot, config),
        message: `Usando última sync (${err.message})`,
        error: err.message
      };
    }

    return {
      alerts: [],
      transit: [],
      nearest: [],
      inPlant: [],
      registered: [],
      config: publicFleetGpsConfig(config),
      message: err.message,
      error: err.message,
      fromCache: false
    };
  }
};

const fetchFleetLiveSnapshot = async (db, options = {}) => {
  const config = await getFleetGpsConfig(db);
  const mergedConfig = {
    ...config,
    guardiaLat: options.guardiaLat ?? config.guardiaLat,
    guardiaLng: options.guardiaLng ?? config.guardiaLng,
    geofenceMode: options.geofenceMode ?? config.geofenceMode,
    gatePolygons: options.gatePolygons ?? config.gatePolygons,
    plantPolygon: options.plantPolygon ?? config.plantPolygon,
    gateRadiusMeters: options.gateRadiusMeters ?? resolveGateRadius(config),
    plantRadiusMeters: options.plantRadiusMeters ?? resolvePlantRadius(config),
    minSpeedKnots: options.minSpeedKnots ?? config.minSpeedKnots,
    requireMotion: options.requireMotion ?? config.requireMotion
  };
  const forceRefresh = Boolean(options.forceRefresh);

  if (!resolveApiKey(mergedConfig)) {
    const missing = getGpsProvider(mergedConfig.provider).missingConfigMessage;
    return {
      vehicles: [],
      error: missing,
      message: missing,
      config: publicFleetGpsConfig(mergedConfig),
      gateRadiusMeters: resolveGateRadius(mergedConfig),
      plantRadiusMeters: resolvePlantRadius(mergedConfig),
      guardiaLat: mergedConfig.guardiaLat,
      guardiaLng: mergedConfig.guardiaLng,
      vehicleCount: 0,
      summary: { moving: 0, stopped: 0, atGate: 0, inPlant: 0, outside: 0 },
      syncedAt: null,
      fromCache: false
    };
  }

  const guardiaLat = Number(mergedConfig.guardiaLat);
  const guardiaLng = Number(mergedConfig.guardiaLng);
  if (Number.isNaN(guardiaLat) || Number.isNaN(guardiaLng)) {
    return {
      vehicles: [],
      error: 'Configure las coordenadas de la guardia',
      message: 'Configure las coordenadas de la guardia',
      config: publicFleetGpsConfig(mergedConfig),
      gateRadiusMeters: resolveGateRadius(mergedConfig),
      plantRadiusMeters: resolvePlantRadius(mergedConfig),
      guardiaLat: mergedConfig.guardiaLat,
      guardiaLng: mergedConfig.guardiaLng,
      vehicleCount: 0,
      summary: { moving: 0, stopped: 0, atGate: 0, inPlant: 0, outside: 0 },
      syncedAt: null,
      fromCache: false
    };
  }

  if (!forceRefresh) {
    const snapshot = await readFleetGpsSnapshot(db);
    if (snapshot && Array.isArray(snapshot.vehicles)) {
      const vehicles = withDistanceAndZone(snapshot.vehicles, mergedConfig);
      const fresh = isSnapshotFresh(snapshot, mergedConfig);
      return {
        vehicles,
        config: publicFleetGpsConfig(mergedConfig),
        gateRadiusMeters: resolveGateRadius(mergedConfig),
        plantRadiusMeters: resolvePlantRadius(mergedConfig),
        guardiaLat,
        guardiaLng,
        vehicleCount: vehicles.length,
        syncedAt: snapshot.syncedAt,
        message: fresh
          ? `${vehicles.length} móvil(es) en mapa`
          : `${vehicles.length} móvil(es) · última sync (se actualiza sola cada pocos minutos)`,
        fromCache: true,
        stale: !fresh,
        summary: snapshot.summary || {
          moving: vehicles.filter((v) => v.moving).length,
          stopped: vehicles.filter((v) => !v.moving).length,
          atGate: vehicles.filter((v) => v.zone === 'gate').length,
          inPlant: vehicles.filter((v) => v.zone === 'plant').length,
          outside: vehicles.filter((v) => v.zone === 'outside').length
        }
      };
    }
  }

  try {
    const vehicles = withDistanceAndZone(await fetchFleetFromProvider(mergedConfig), mergedConfig);
    const gateRadius = resolveGateRadius(mergedConfig);
    const plantRadius = resolvePlantRadius(mergedConfig);
    const syncedAt = new Date().toISOString();
    const summary = {
      moving: vehicles.filter((v) => v.moving).length,
      stopped: vehicles.filter((v) => !v.moving).length,
      atGate: vehicles.filter((v) => v.zone === 'gate').length,
      inPlant: vehicles.filter((v) => v.zone === 'plant').length,
      outside: vehicles.filter((v) => v.zone === 'outside').length
    };

    return {
      vehicles,
      config: publicFleetGpsConfig(mergedConfig),
      gateRadiusMeters: gateRadius,
      plantRadiusMeters: plantRadius,
      guardiaLat,
      guardiaLng,
      vehicleCount: vehicles.length,
      syncedAt,
      message: `${vehicles.length} móvil(es) en mapa`,
      fromCache: false,
      summary
    };
  } catch (err) {
    const snapshot = await readFleetGpsSnapshot(db);
    if (snapshot?.vehicles?.length) {
      return {
        vehicles: withDistanceAndZone(snapshot.vehicles, mergedConfig),
        error: err.message,
        message: `Usando última sync (${err.message})`,
        config: publicFleetGpsConfig(mergedConfig),
        gateRadiusMeters: resolveGateRadius(mergedConfig),
        plantRadiusMeters: resolvePlantRadius(mergedConfig),
        guardiaLat,
        guardiaLng,
        vehicleCount: snapshot.vehicleCount || snapshot.vehicles.length,
        summary: snapshot.summary || { moving: 0, stopped: 0, atGate: 0, inPlant: 0, outside: 0 },
        syncedAt: snapshot.syncedAt || null,
        fromCache: true
      };
    }
    return {
      vehicles: [],
      error: err.message,
      message: err.message,
      config: publicFleetGpsConfig(mergedConfig),
      gateRadiusMeters: resolveGateRadius(mergedConfig),
      plantRadiusMeters: resolvePlantRadius(mergedConfig),
      guardiaLat,
      guardiaLng,
      vehicleCount: 0,
      summary: { moving: 0, stopped: 0, atGate: 0, inPlant: 0, outside: 0 },
      syncedAt: null,
      fromCache: false
    };
  }
};

module.exports = {
  DEFAULT_FLEET_GPS,
  API_KEY_MASK,
  getFleetGpsConfig,
  publicFleetGpsConfig,
  saveFleetGpsConfig,
  saveFleetGpsGeofence,
  fetchNearbyFleetAlerts,
  fetchFleetLiveSnapshot,
  fetchUbikaFleet,
  fetchFleetFromProvider,
  distanceMeters,
  extractPlate,
  extractVehicleLabel,
  resolveZone,
  isVehicleMoving,
  resolveGpsVehicleDetails,
  normalizeGeoCoordinate,
  normalizeFleetGpsConfig,
  usesPolygonGeofence,
  detectApproachingVehicles,
  resolveTransitDirection,
  resolveGpsEventTimeIso,
  invalidateFleetLookupCache,
  warmFleetLookupCache
};
