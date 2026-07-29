/**
 * Marcas de hardware de acceso homologadas (Fase A — plantillas de producto).
 * Textos orientados a configuración por personal no técnico.
 */

const ACCESS_HARDWARE_BRANDS = [
  {
    id: 'zkteco',
    name: 'ZKTeco',
    shortName: 'ZKTeco',
    kinds: ['biometric', 'card'],
    summary: 'Lectores de huella, rostro y tarjeta muy usados en empresas.',
    howItConnects: 'El equipo identifica a la persona y le avisa a MSS Guard quién pasó. MSS decide si abre la puerta.',
    setupSteps: [
      'Instalá el lector en la puerta o molinete según el manual del fabricante.',
      'En MSS, en la ficha de cada persona, cargá el ID que muestra el equipo (huella/rostro/tarjeta).',
      'Asociá el lector a la puerta correspondiente en Equipos de acceso → Lectores.',
      'Probá un ingreso de prueba con una persona autorizada.'
    ],
    personFieldHint: 'Usá el campo “ID en el lector biométrico” con el número o código que asigna ZKTeco a esa persona.',
    stationPlugin: 'zkteco'
  },
  {
    id: 'hikvision',
    name: 'Hikvision',
    shortName: 'Hikvision',
    kinds: ['biometric', 'card'],
    summary: 'Control de acceso y video; suele usarse rostro o tarjeta.',
    howItConnects: 'Igual que otras marcas: el equipo manda la identidad; MSS autoriza y abre.',
    setupSteps: [
      'Configurá el equipo en la red de planta.',
      'Anotá el ID de usuario que Hikvision asigna a cada persona.',
      'Cargalo en la ficha de la persona en MSS (ID biométrico o tarjeta).',
      'Vinculá el dispositivo a la puerta en Equipos de acceso.'
    ],
    personFieldHint: 'El “ID en el lector biométrico” debe coincidir con el User ID del equipo Hikvision.',
    stationPlugin: 'hikvision'
  },
  {
    id: 'suprema',
    name: 'Suprema',
    shortName: 'Suprema',
    kinds: ['biometric', 'card'],
    summary: 'Biometría de alta gama (huella / rostro) frecuente en edificios corporativos.',
    howItConnects: 'El lector Suprema identifica; MSS Guard aplica las reglas de la planta.',
    setupSteps: [
      'Enrolá a la persona en el equipo Suprema.',
      'Copiá el identificador de usuario a la ficha en MSS.',
      'Asociá el lector a la puerta correcta.',
      'Verificá un acceso de prueba.'
    ],
    personFieldHint: 'Cargá en “ID en el lector biométrico” el mismo ID de usuario de Suprema.',
    stationPlugin: 'suprema'
  },
  {
    id: 'hid',
    name: 'HID',
    shortName: 'HID',
    kinds: ['card'],
    summary: 'Tarjetas y lectores de proximidad muy difundidos en control de acceso.',
    howItConnects: 'Al pasar la tarjeta, el código llega a MSS como credencial; si la persona está autorizada, se abre.',
    setupSteps: [
      'Leé el número de la tarjeta (o el que muestra el software HID).',
      'Cargalo en la ficha de la persona → “Número de tarjeta”.',
      'Asegurate de que la puerta acepte “Tarjeta / credencial”.',
      'Probá el acceso.'
    ],
    personFieldHint: 'Usá el campo “Número de tarjeta” con el código de la tarjeta HID.',
    stationPlugin: 'hid'
  },
  {
    id: 'dni_generic',
    name: 'Lector de DNI (documento)',
    shortName: 'DNI',
    kinds: ['dni'],
    summary: 'Lectores USB o 2D que leen el código del DNI argentino (como el flujo actual).',
    howItConnects: 'Ya integrado: el DNI se lee y MSS busca a la persona por documento.',
    setupSteps: [
      'Conectá el lector a la PC de guardia o a la estación de la puerta.',
      'No hace falta cargar un ID extra: alcanza con el DNI en la ficha.',
      'Configurá la puerta con método “DNI”.'
    ],
    personFieldHint: 'Con DNI alcanza el campo Documento / DNI de la persona.',
    stationPlugin: 'serial_dni'
  }
];

/**
 * Paquetes comerciales de instalación (Fase C — empaque).
 * Sirven para cotizar: qué incluye, marcas típicas, métodos y forma de abrir.
 */
const ACCESS_COMMERCIAL_PROFILES = [
  {
    id: 'dni_only',
    name: 'Solo DNI',
    tagline: 'Ingreso por documento, como el flujo actual.',
    includes: [
      'Lectores de DNI',
      'Decisión y auditoría en MSS Guard',
      'Apertura con placa SR201 o URL HTTP'
    ],
    brandIds: ['dni_generic'],
    authMethods: ['dni', 'manual'],
    actuators: ['sr201', 'generic_http'],
    integration: 'homologado',
    notes: 'Listo para vender e instalar sin desarrollo extra.'
  },
  {
    id: 'dni_card',
    name: 'DNI + Tarjeta',
    tagline: 'Documento y tarjeta (HID u otra) en la misma planta.',
    includes: [
      'Campos de tarjeta en la ficha de persona',
      'Puertas que aceptan DNI y credencial',
      'Plugin de estación HID / prefijo CARD#'
    ],
    brandIds: ['dni_generic', 'hid'],
    authMethods: ['dni', 'credential', 'manual'],
    actuators: ['sr201', 'generic_http'],
    integration: 'homologado',
    notes: 'Homologado para HID; otras tarjetas usan el mismo contrato CARD#.'
  },
  {
    id: 'biometric_zkteco',
    name: 'Biometría ZKTeco',
    tagline: 'Huella o rostro con ID cargado en la ficha.',
    includes: [
      'ID biométrico por persona',
      'Plugin de estación ZKTeco → /access/ingest',
      'Método biométrico en la puerta'
    ],
    brandIds: ['zkteco'],
    authMethods: ['biometric', 'manual'],
    actuators: ['sr201', 'generic_http'],
    integration: 'homologado',
    notes: 'Primera marca biométrica prioritaria. El equipo identifica; MSS autoriza.'
  },
  {
    id: 'biometric_multi',
    name: 'Biometría multi-marca',
    tagline: 'ZKTeco, Hikvision o Suprema con el mismo cerebro MSS.',
    includes: [
      'Misma ficha de persona (ID biométrico + marca)',
      'Plugins de estación por marca',
      'Contrato único de ingest'
    ],
    brandIds: ['zkteco', 'hikvision', 'suprema'],
    authMethods: ['biometric', 'credential', 'manual'],
    actuators: ['sr201', 'generic_http'],
    integration: 'homologado',
    notes: 'Configuración por plugin; sin rehacer el núcleo por cada marca.'
  },
  {
    id: 'custom_brand',
    name: 'Marca a medida',
    tagline: 'Cliente trae otra marca: se evalúa un conector.',
    includes: [
      'Análisis del protocolo del equipo',
      'Plugin o webhook hacia /access/ingest',
      'Misma autorización y auditoría MSS'
    ],
    brandIds: [],
    authMethods: ['dni', 'credential', 'biometric', 'manual'],
    actuators: ['sr201', 'generic_http'],
    integration: 'custom',
    notes: 'No es rehacer el sistema: es un traductor sobre la base multi-hardware.'
  }
];

const getAccessHardwareBrand = (id) =>
  ACCESS_HARDWARE_BRANDS.find((b) => b.id === id) || null;

const getAccessCommercialProfile = (id) =>
  ACCESS_COMMERCIAL_PROFILES.find((p) => p.id === id) || null;

module.exports = {
  ACCESS_HARDWARE_BRANDS,
  ACCESS_COMMERCIAL_PROFILES,
  getAccessHardwareBrand,
  getAccessCommercialProfile
};
