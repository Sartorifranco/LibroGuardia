'use strict';

/**
 * Estado de la puesta en marcha. Pocas lecturas: documentos sueltos o limit(1)/limit(N).
 * La pantalla Primeros pasos solo muestra el resultado.
 */

const { db } = require('../firestore');

const SITE_ID = () => {
  const id = String(process.env.SITE_ID || 'principal').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'principal';
};

const ONLINE_MS = 3 * 60 * 1000;

const step = (partial) => ({
  status: 'pending',
  optional: false,
  ...partial
});

const personHasAccess = (data = {}) => {
  if (data.active === false) return false;
  if (data.accessAll === true) return true;
  if (Array.isArray(data.accessLevels) && data.accessLevels.length > 0) return true;
  if (Array.isArray(data.allowedDoorIds) && data.allowedDoorIds.length > 0) return true;
  return false;
};

const isActiveUser = (data = {}) => data.active !== false && data.disabled !== true;

const deviceOnline = (data = {}, now = Date.now()) => {
  if (data.status !== 'active') return false;
  if (data.online === true) return true;
  const seen = Number(data.lastSeenAt);
  return Number.isFinite(seen) && now - seen >= 0 && now - seen <= ONLINE_MS;
};

const deviceProblem = (data = {}, now = Date.now()) => {
  if (data.status !== 'active' || data.status === 'revoked' || data.status === 'replaced') return false;
  return !deviceOnline(data, now);
};

const alarmOpen = (data = {}) => {
  const acked = Boolean(data.ackBy || data.ack_by) || data.state === 'acked' || data.state === 'closed';
  return !acked && data.state !== 'closed';
};

const mailReady = (config = {}) => {
  const smtp = config.smtp || {};
  const hostOk = Boolean(String(smtp.host || '').trim() && String(smtp.from || '').trim());
  const events = config.events && typeof config.events === 'object' ? Object.values(config.events) : [];
  const recipients = events.some((event) => Array.isArray(event && event.recipients) && event.recipients.filter(Boolean).length > 0);
  return hostOk && recipients;
};

/**
 * @param {object} facts lecturas ya hechas
 * @param {number} [now]
 */
const computeSetupStatus = (facts = {}, now = Date.now()) => {
  const year = new Date(now).getFullYear();
  const companyName = String(facts.companyName || '').trim();
  const areas = (facts.areas || []).filter((area) => area && area.id && area.id !== 'exterior');
  const doors = (facts.doors || []).filter((door) => door && door.active !== false);
  const doorConnectsPlaces = (door) => {
    const inn = door.sides && door.sides.in;
    const from = String((inn && inn.zoneFrom) || '').trim();
    const to = String((inn && inn.zoneTo) || '').trim();
    return Boolean(from && to && from !== to);
  };
  const doorsMissingPlaces = doors.filter((door) => !doorConnectsPlaces(door));
  const lugaresReady = doors.length > 0 && doorsMissingPlaces.length === 0;
  const devices = facts.devices || [];
  const installedOnline = devices.filter((device) => deviceOnline(device, now));
  const schedules = (facts.schedules || []).filter((item) => item && item.id !== '24x7');
  const holidayCount = Array.isArray(facts.holidayDates) ? facts.holidayDates.length : 0;
  const groups = facts.groups || [];
  const people = facts.peopleWithAccess || [];
  const guardias = (facts.guardias || []).filter(isActiveUser);
  const responsables = (facts.responsables || []).filter(isActiveUser);
  const mail = mailReady(facts.notifications || {});
  const tried = Boolean(facts.lastSimulateAt);

  const steps = [
    step({
      id: 'empresa',
      title: 'Datos de la empresa',
      what: 'El nombre con el que se ve el sistema.',
      why: 'Así los guardias y las visitas reconocen de qué predio se trata.',
      section: 'appearance',
      status: companyName ? 'done' : 'pending'
    }),
    step({
      id: 'lugares',
      title: 'Lugares y puertas',
      what: 'Al menos una puerta que conecta dos lugares.',
      why: 'Sin puertas cargadas nadie puede entrar ni salir por el sistema.',
      section: areas.length ? 'puertas' : 'lugares',
      status: lugaresReady ? 'done' : 'pending',
      ...(doorsMissingPlaces.length
        ? { detail: 'Falta indicar qué lugares conecta en alguna puerta.' }
        : {})
    }),
    step({
      id: 'equipos',
      title: 'Equipos',
      what: 'Al menos un equipo instalado y en línea.',
      why: 'El equipo es la cajita que abre la puerta de verdad.',
      section: 'equipos',
      status: installedOnline.length >= 1 ? 'done' : 'pending'
    }),
    step({
      id: 'horarios',
      title: 'Horarios y feriados',
      what: schedules.length
        ? `Tenés ${schedules.length} horario${schedules.length === 1 ? '' : 's'} propio${schedules.length === 1 ? '' : 's'}.`
        : 'Podés usar el horario Siempre, que vale todos los días.',
      why: 'Un horario dice en qué días y horas vale un permiso. Los feriados cambian ese día.',
      section: holidayCount ? 'horarios' : 'feriados',
      status: holidayCount > 0 ? 'done' : 'pending',
      detail: holidayCount > 0 ? `Feriados de ${year} cargados.` : `Falta cargar los feriados de ${year}.`
    }),
    step({
      id: 'grupos',
      title: 'Grupos de acceso',
      what: 'Al menos un grupo de puertas.',
      why: 'El grupo es la forma simple de decir quién pasa por dónde.',
      section: 'grupos',
      status: groups.length >= 1 ? 'done' : 'pending'
    }),
    step({
      id: 'personas',
      title: 'Personas',
      what: 'Al menos una persona con un grupo o una puerta.',
      why: 'Si nadie tiene permiso, la puerta no abre para nadie.',
      section: 'peopleAccess',
      status: people.length >= 1 ? 'done' : 'pending'
    }),
    step({
      id: 'usuarios',
      title: 'Usuarios',
      what: 'Al menos un guardia y un responsable.',
      why: 'El guardia opera la puerta. El responsable aprueba ingresos.',
      section: 'users',
      status: guardias.length >= 1 && responsables.length >= 1 ? 'done' : 'pending',
      detail: `Guardias: ${guardias.length}. Responsables: ${responsables.length}.`
    }),
    step({
      id: 'avisos',
      title: 'Avisos',
      what: 'El correo configurado y al menos un destinatario.',
      why: 'Si una puerta queda abierta o falla, alguien tiene que enterarse.',
      section: 'notifications',
      status: mail ? 'done' : 'pending'
    }),
    step({
      id: 'probar',
      title: 'Probar con ¿Puede pasar?',
      what: 'Una prueba de si una persona entra por una puerta.',
      why: 'Es la forma de confirmar que el permiso quedó bien, antes de usarlo en la puerta.',
      section: 'puedePasar',
      status: 'optional'
    })
  ];

  const requiredDone = steps.filter((item) => item.id !== 'probar').every((item) => item.status === 'done');
  const probar = steps.find((item) => item.id === 'probar');
  if (tried) probar.status = 'done';
  else if (requiredDone) probar.status = 'pending';
  else probar.status = 'optional';

  const done = steps.filter((item) => item.status === 'done').length;
  const problems = devices.filter((device) => deviceProblem(device, now)).slice(0, 8).map((device) => ({
    id: device.id,
    name: device.name || device.id
  }));

  return {
    complete: steps.every((item) => item.status === 'done' || item.status === 'optional') && requiredDone && probar.status === 'done',
    progress: { done, total: steps.length, percent: Math.round((done / steps.length) * 100) },
    steps,
    board: {
      devicesProblem: problems,
      pendingAuthorizations: Number(facts.pendingAuthorizations) || 0,
      openAlarms: Number(facts.openAlarms) || 0
    }
  };
};

const firstDocs = async (query) => {
  const snap = await query;
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
};

const loadSetupFacts = async (now = Date.now()) => {
  const year = String(new Date(now).getFullYear());
  const site = SITE_ID();
  const [
    appearanceSnap,
    doorsSnap,
    areasSnap,
    devices,
    schedules,
    holidaySnap,
    groups,
    peopleSample,
    guardias,
    responsables,
    notificationsSnap,
    progressSnap,
    alarms,
    pendingReqs
  ] = await Promise.all([
    db.collection('systemConfig').doc('appearance').get(),
    db.collection('settings').doc('doorsConfig').get(),
    db.collection('sites').doc(site).collection('areas').limit(30).get(),
    firstDocs(db.collection('devices').limit(30).get()),
    firstDocs(db.collection('schedules').limit(8).get()),
    db.collection('holidays').doc(year).get(),
    firstDocs(db.collection('accessGroups').limit(8).get()),
    firstDocs(db.collection('people').limit(40).get()),
    firstDocs(db.collection('users').where('role', '==', 'guardia').limit(5).get()),
    firstDocs(db.collection('users').where('role', '==', 'responsable').limit(5).get()),
    db.collection('settings').doc('notificationsConfig').get(),
    db.collection('settings').doc('setupProgress').get(),
    firstDocs(db.collection('sites').doc(site).collection('alarms').limit(40).get()),
    firstDocs(db.collection('accessRequests').where('estado', '==', 'pendiente').limit(40).get())
  ]);

  const appearance = appearanceSnap.exists ? (appearanceSnap.data() || {}) : {};
  const doorsConfig = doorsSnap.exists ? (doorsSnap.data() || {}) : {};
  const holiday = holidaySnap.exists ? (holidaySnap.data() || {}) : {};
  const progress = progressSnap.exists ? (progressSnap.data() || {}) : {};

  return {
    companyName: appearance.companyName || '',
    areas: areasSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })),
    doors: Array.isArray(doorsConfig.doors) ? doorsConfig.doors : [],
    devices,
    schedules,
    holidayDates: Array.isArray(holiday.dates) ? holiday.dates : [],
    groups,
    peopleWithAccess: peopleSample.filter(personHasAccess),
    guardias,
    responsables,
    notifications: notificationsSnap.exists ? (notificationsSnap.data() || {}) : {},
    lastSimulateAt: progress.lastSimulateAt || null,
    pendingAuthorizations: pendingReqs.filter((row) => row.estado === 'pendiente' || row.estado === 'revision').length,
    openAlarms: alarms.filter(alarmOpen).length
  };
};

const getSetupStatus = async (now = Date.now()) => computeSetupStatus(await loadSetupFacts(now), now);

module.exports = {
  computeSetupStatus,
  loadSetupFacts,
  getSetupStatus,
  personHasAccess,
  deviceOnline,
  mailReady
};
