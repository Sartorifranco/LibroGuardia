const DEFAULT_FLEET_GPS = {
  enabled: false,
  provider: 'ubika',
  apiUrl: process.env.UBIKA_API_URL || 'https://ubika.rastreo.com.ar',
  apiKey: process.env.UBIKA_API_TOKEN || '',
  guardiaLat: null,
  guardiaLng: null,
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
  pollIntervalSeconds: 20,
  lastError: null,
  lastSyncAt: null
};

const API_KEY_MASK = '********';
const TRACKS_COLLECTION = 'fleetGpsTracks';

const toRadians = (value) => (value * Math.PI) / 180;

const distanceMeters = (lat1, lng1, lat2, lng2) => {
  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const extractPlate = (name = '') => {
  const match = String(name).match(/\b([A-Z]{2,3}\d{3}[A-Z]{2,3}|\d{3}[A-Z]{3}|[A-Z]{3}\d{3})\b/i);
  return match ? match[1].toUpperCase() : null;
};

const resolveApiKey = (config) => {
  const key = config?.apiKey;
  if (key && key !== API_KEY_MASK) return key;
  return process.env.UBIKA_API_TOKEN || '';
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

const publicFleetGpsConfig = (config) => ({
  ...config,
  apiKey: config.apiKey ? API_KEY_MASK : '',
  hasApiKey: Boolean(resolveApiKey(config)),
  gateRadiusMeters: resolveGateRadius(config),
  plantRadiusMeters: resolvePlantRadius(config),
  alertRadiusMeters: resolveGateRadius(config),
  lastSyncAt: serializeTimestamp(config.lastSyncAt),
  updatedAt: serializeTimestamp(config.updatedAt)
});

const getFleetGpsConfig = async (db) => {
  const snap = await db.collection('settings').doc('fleetGps').get();
  const stored = snap.exists ? snap.data() : {};
  const merged = { ...DEFAULT_FLEET_GPS, ...stored };
  if (!merged.apiKey) {
    merged.apiKey = process.env.UBIKA_API_TOKEN || '';
  }
  if (!merged.apiUrl) {
    merged.apiUrl = process.env.UBIKA_API_URL || DEFAULT_FLEET_GPS.apiUrl;
  }
  // Migración: configs viejas con radio grande (planta) → portón chico
  if (stored.gateRadiusMeters == null && Number(stored.alertRadiusMeters) > 80) {
    merged.gateRadiusMeters = DEFAULT_FLEET_GPS.gateRadiusMeters;
    merged.plantRadiusMeters = Math.max(Number(stored.alertRadiusMeters), DEFAULT_FLEET_GPS.plantRadiusMeters);
  }
  return merged;
};

const parseOptionalNumber = (value) => {
  if (value === null || value === '') return null;
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isNaN(num) ? undefined : num;
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
  if (guardiaLat !== undefined) updates.guardiaLat = guardiaLat;
  const guardiaLng = parseOptionalNumber(body.guardiaLng);
  if (guardiaLng !== undefined) updates.guardiaLng = guardiaLng;

  const gateRadius = parseOptionalNumber(body.gateRadiusMeters ?? body.alertRadiusMeters);
  if (gateRadius != null && gateRadius > 0) {
    updates.gateRadiusMeters = gateRadius;
    updates.alertRadiusMeters = gateRadius;
  }

  const plantRadius = parseOptionalNumber(body.plantRadiusMeters);
  if (plantRadius != null && plantRadius > 0) updates.plantRadiusMeters = plantRadius;

  const minSpeed = parseOptionalNumber(body.minSpeedKnots);
  if (minSpeed != null && minSpeed >= 0) updates.minSpeedKnots = minSpeed;

  const cooldown = parseOptionalNumber(body.movementCooldownSeconds);
  if (cooldown != null && cooldown >= 60) updates.movementCooldownSeconds = cooldown;

  const poll = parseOptionalNumber(body.pollIntervalSeconds);
  if (poll != null && poll >= 15) updates.pollIntervalSeconds = poll;

  return updates;
};

const saveFleetGpsConfig = async (db, FieldValue, body) => {
  const updates = sanitizeFleetGpsUpdates(body);
  await db.collection('settings').doc('fleetGps').set({
    ...updates,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return getFleetGpsConfig(db);
};

const ubikaFetchJson = async (url, apiKey) => {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.message || payload.error || `HTTP ${response.status}`;
    throw new Error(`UBIKA ${message}`);
  }
  return payload;
};

const fetchUbikaFleet = async (config) => {
  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    throw new Error('Falta token de API UBIKA');
  }

  const baseUrl = (config.apiUrl || DEFAULT_FLEET_GPS.apiUrl).replace(/\/$/, '');
  const [devicesPayload, positionsPayload] = await Promise.all([
    ubikaFetchJson(`${baseUrl}/api/devices`, apiKey),
    ubikaFetchJson(`${baseUrl}/api/positions`, apiKey)
  ]);

  const devices = Array.isArray(devicesPayload) ? devicesPayload : [];
  const positions = Array.isArray(positionsPayload) ? positionsPayload : [];
  const deviceById = new Map(devices.map((device) => [device.id, device]));

  return positions
    .filter((position) => (
      position
      && position.valid !== false
      && position.latitude != null
      && position.longitude != null
      && !Number.isNaN(Number(position.latitude))
      && !Number.isNaN(Number(position.longitude))
    ))
    .map((position) => {
      const device = deviceById.get(position.deviceId);
      const name = device?.name || `Dispositivo ${position.deviceId}`;
      return {
        id: String(device?.uniqueId || position.deviceId),
        deviceId: position.deviceId,
        name,
        plate: extractPlate(name),
        status: device?.status || 'unknown',
        lat: Number(position.latitude),
        lng: Number(position.longitude),
        speed: Number(position.speed) || 0,
        fixTime: position.fixTime || position.deviceTime || null,
        ignition: Boolean(position.attributes?.ignition),
        motion: Boolean(position.attributes?.motion)
      };
    });
};

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
  const gateRadius = resolveGateRadius(config);
  const plantRadius = resolvePlantRadius(config);

  if (Number.isNaN(guardiaLat) || Number.isNaN(guardiaLng)) {
    return vehicles.map((vehicle) => ({
      ...vehicle,
      distanceMeters: null,
      zone: 'unknown',
      moving: isVehicleMoving(vehicle, config)
    }));
  }

  return vehicles
    .map((vehicle) => {
      const distance = Math.round(distanceMeters(guardiaLat, guardiaLng, vehicle.lat, vehicle.lng));
      return {
        ...vehicle,
        distanceMeters: distance,
        zone: resolveZone(distance, gateRadius, plantRadius),
        moving: isVehicleMoving(vehicle, config)
      };
    })
    .sort((a, b) => (a.distanceMeters ?? Number.POSITIVE_INFINITY) - (b.distanceMeters ?? Number.POSITIVE_INFINITY));
};

const loadTracks = async (db, deviceIds) => {
  const map = new Map();
  await Promise.all(deviceIds.map(async (deviceId) => {
    const snap = await db.collection(TRACKS_COLLECTION).doc(String(deviceId)).get();
    if (snap.exists) map.set(String(deviceId), snap.data());
  }));
  return map;
};

const lookupVehicleMaster = async (db, plate) => {
  if (!plate) return null;
  const snap = await db.collection('vehiclesMaster')
    .where('plateNormalized', '==', String(plate).toUpperCase())
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
};

const withinCooldown = (track, movementType, cooldownSeconds) => {
  if (!track?.lastMovementAt || track.lastMovementType !== movementType) return false;
  const lastAt = track.lastMovementAt?.toDate
    ? track.lastMovementAt.toDate()
    : new Date(track.lastMovementAt);
  if (Number.isNaN(lastAt.getTime())) return false;
  return (Date.now() - lastAt.getTime()) < cooldownSeconds * 1000;
};

const registerGpsMovement = async (db, FieldValue, vehicle, movementType, meta = {}) => {
  const master = await lookupVehicleMaster(db, vehicle.plate);
  const entryData = {
    type: 'vehiculo',
    movementType,
    plate: vehicle.plate || vehicle.name,
    brand: master?.brand || '',
    company: master?.company || 'Flota interna',
    driver: master?.driver || '',
    authorized: master ? master.authorized !== false : true,
    authorizedStatus: master
      ? (master.authorized === false ? 'not_authorized' : 'authorized')
      : 'gps_fleet',
    entrySource: 'gps_ubika',
    gpsAuto: true,
    gpsDeviceId: vehicle.deviceId,
    gpsName: vehicle.name,
    gpsDistanceMeters: vehicle.distanceMeters,
    gpsSpeed: vehicle.speed,
    registeredBy: meta.userId || 'sistema_gps',
    timestamp: FieldValue.serverTimestamp(),
    eventTime: null,
    notes: `Movimiento GPS UBIKA (${movementType}) — ${vehicle.name}`
  };

  const ref = await db.collection('entries').add(entryData);
  return { entryId: ref.id, entry: entryData, master };
};

const processTransit = async (db, FieldValue, vehicles, config, options = {}) => {
  const gateRadius = resolveGateRadius(config);
  const cooldown = Number(config.movementCooldownSeconds) || DEFAULT_FLEET_GPS.movementCooldownSeconds;
  const autoRegister = config.autoRegisterMovements !== false && !options.skipAutoRegister;
  const tracks = await loadTracks(db, vehicles.map((v) => v.deviceId));

  const transit = [];
  const registered = [];
  const trackUpdates = [];

  for (const vehicle of vehicles) {
    const trackKey = String(vehicle.deviceId);
    const prev = tracks.get(trackKey);
    const prevZone = prev?.zone || vehicle.zone;
    let direction = null;

    if (vehicle.zone === 'gate' && vehicle.moving) {
      if (prevZone === 'outside') direction = 'ingreso';
      else if (prevZone === 'plant') direction = 'egreso';
      else if (prevZone === 'gate' && prev?.pendingDirection) {
        direction = prev.pendingDirection;
      }
    }

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
      lastSeenAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

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
          const result = await registerGpsMovement(db, FieldValue, vehicle, direction, options);
          item.entryId = result.entryId;
          item.registered = true;
          item.pending = false;
          trackUpdate.lastMovementType = direction;
          trackUpdate.lastMovementAt = FieldValue.serverTimestamp();
          trackUpdate.lastEntryId = result.entryId;
          trackUpdate.pendingDirection = null;
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

    trackUpdates.push({ trackKey, trackUpdate });
  }

  for (let i = 0; i < trackUpdates.length; i += 400) {
    const batch = db.batch();
    trackUpdates.slice(i, i + 400).forEach(({ trackKey, trackUpdate }) => {
      batch.set(db.collection(TRACKS_COLLECTION).doc(trackKey), trackUpdate, { merge: true });
    });
    await batch.commit();
  }

  return { transit, registered };
};

const fetchNearbyFleetAlerts = async (db, FieldValue, options = {}) => {
  const config = await getFleetGpsConfig(db);
  const force = Boolean(options.force);

  if (!config.enabled && !force) {
    return {
      alerts: [],
      transit: [],
      nearest: [],
      inPlant: [],
      registered: [],
      config: publicFleetGpsConfig(config),
      message: 'GPS de flota deshabilitado'
    };
  }

  if (!resolveApiKey(config)) {
    return {
      alerts: [],
      transit: [],
      nearest: [],
      inPlant: [],
      registered: [],
      config: publicFleetGpsConfig(config),
      message: 'Configure el token de API UBIKA',
      error: 'Configure el token de API UBIKA'
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
      error: 'Configure las coordenadas de la guardia'
    };
  }

  try {
    const vehicles = withDistanceAndZone(await fetchUbikaFleet(config), config);
    const gateRadius = resolveGateRadius(config);
    const plantRadius = resolvePlantRadius(config);

    const { transit, registered } = await processTransit(db, FieldValue, vehicles, config, options);

    const inPlantParked = vehicles.filter((v) => v.zone === 'plant' && !v.moving);
    const atGateStopped = vehicles.filter((v) => v.zone === 'gate' && !v.moving);
    const nearest = vehicles.slice(0, 15);

    await db.collection('settings').doc('fleetGps').set({
      lastSyncAt: FieldValue.serverTimestamp(),
      lastError: null
    }, { merge: true });

    const syncedAt = new Date().toISOString();
    const message = transit.length
      ? `${transit.length} móvil(es) en tránsito por el portón`
      : `Sin tránsito en portón (${inPlantParked.length} estacionados en planta, ${vehicles.length} en flota)`;

    return {
      alerts: transit,
      transit,
      registered,
      atGateStopped,
      inPlant: inPlantParked.slice(0, 20),
      nearest,
      config: publicFleetGpsConfig({ ...config, lastSyncAt: syncedAt, lastError: null }),
      vehicleCount: vehicles.length,
      gateRadiusMeters: gateRadius,
      plantRadiusMeters: plantRadius,
      message
    };
  } catch (err) {
    await db.collection('settings').doc('fleetGps').set({
      lastError: err.message,
      lastSyncAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return {
      alerts: [],
      transit: [],
      nearest: [],
      inPlant: [],
      registered: [],
      config: publicFleetGpsConfig(config),
      message: err.message,
      error: err.message
    };
  }
};

module.exports = {
  DEFAULT_FLEET_GPS,
  API_KEY_MASK,
  getFleetGpsConfig,
  publicFleetGpsConfig,
  saveFleetGpsConfig,
  fetchNearbyFleetAlerts,
  fetchUbikaFleet,
  distanceMeters,
  extractPlate,
  resolveZone,
  isVehicleMoving
};
