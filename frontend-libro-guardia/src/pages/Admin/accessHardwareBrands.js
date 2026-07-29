/**
 * Marcas de hardware de acceso homologadas (UI Admin).
 * Mantener alineado con functions/lib/accessHardwareBrands.js
 */

export const ACCESS_HARDWARE_BRANDS = [
  {
    id: 'zkteco',
    name: 'ZKTeco',
    kinds: ['Biometría', 'Tarjeta'],
    summary: 'Lectores de huella, rostro y tarjeta muy usados en empresas.',
    howItConnects: 'El equipo identifica a la persona y le avisa a MSS Guard quién pasó. MSS decide si abre la puerta.',
    setupSteps: [
      'Instalá el lector según el manual del fabricante.',
      'En la ficha de cada persona, cargá el ID que muestra el equipo.',
      'Asociá el lector a la puerta en la pestaña Lectores.',
      'Probá un ingreso con una persona autorizada.'
    ],
    personFieldHint: 'Campo “ID en el lector biométrico” = código que asigna ZKTeco a esa persona.'
  },
  {
    id: 'hikvision',
    name: 'Hikvision',
    kinds: ['Biometría', 'Tarjeta'],
    summary: 'Control de acceso y video; suele usarse rostro o tarjeta.',
    howItConnects: 'El equipo manda la identidad; MSS autoriza y abre.',
    setupSteps: [
      'Configurá el equipo en la red de planta.',
      'Anotá el User ID que Hikvision asigna a cada persona.',
      'Cargalo en la ficha de la persona en MSS.',
      'Vinculá el dispositivo a la puerta.'
    ],
    personFieldHint: '“ID en el lector biométrico” debe coincidir con el User ID de Hikvision.'
  },
  {
    id: 'suprema',
    name: 'Suprema',
    kinds: ['Biometría', 'Tarjeta'],
    summary: 'Biometría frecuente en edificios corporativos.',
    howItConnects: 'El lector identifica; MSS aplica las reglas de la planta.',
    setupSteps: [
      'Enrolá a la persona en el equipo Suprema.',
      'Copiá el ID de usuario a la ficha en MSS.',
      'Asociá el lector a la puerta correcta.',
      'Verificá un acceso de prueba.'
    ],
    personFieldHint: 'Mismo ID de usuario de Suprema en “ID en el lector biométrico”.'
  },
  {
    id: 'hid',
    name: 'HID',
    kinds: ['Tarjeta'],
    summary: 'Tarjetas y lectores de proximidad muy difundidos.',
    howItConnects: 'Al pasar la tarjeta, MSS la reconoce como credencial y abre si corresponde.',
    setupSteps: [
      'Obtené el número de la tarjeta.',
      'Cargalo en “Número de tarjeta” de la persona.',
      'La puerta debe aceptar “Tarjeta / credencial”.',
      'Probá el acceso.'
    ],
    personFieldHint: 'Usá el campo “Número de tarjeta”.'
  },
  {
    id: 'dni_generic',
    name: 'Lector de DNI',
    kinds: ['Documento'],
    summary: 'Lectores que leen el código del DNI (flujo actual de MSS Guard).',
    howItConnects: 'Ya integrado: se busca a la persona por documento.',
    setupSteps: [
      'Conectá el lector a la PC de guardia o estación.',
      'Con el DNI en la ficha alcanza.',
      'La puerta debe aceptar método DNI.'
    ],
    personFieldHint: 'Alcanza el DNI de la persona.'
  }
];

/** Paquetes de venta / instalación (alineado con backend). */
export const ACCESS_COMMERCIAL_PROFILES = [
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
    integration: 'homologado',
    notes: 'Homologado para HID; otras tarjetas usan el mismo contrato CARD#.'
  },
  {
    id: 'biometric_zkteco',
    name: 'Biometría ZKTeco',
    tagline: 'Huella o rostro con ID cargado en la ficha.',
    includes: [
      'ID biométrico por persona',
      'Plugin de estación ZKTeco',
      'Método biométrico en la puerta'
    ],
    brandIds: ['zkteco'],
    integration: 'homologado',
    notes: 'Primera marca biométrica prioritaria.'
  },
  {
    id: 'biometric_multi',
    name: 'Biometría multi-marca',
    tagline: 'ZKTeco, Hikvision o Suprema con el mismo cerebro MSS.',
    includes: [
      'Misma ficha de persona',
      'Plugins de estación por marca',
      'Contrato único de ingest'
    ],
    brandIds: ['zkteco', 'hikvision', 'suprema'],
    integration: 'homologado',
    notes: 'Configuración por plugin; sin rehacer el núcleo.'
  },
  {
    id: 'custom_brand',
    name: 'Marca a medida',
    tagline: 'Cliente trae otra marca: se evalúa un conector.',
    includes: [
      'Análisis del protocolo del equipo',
      'Plugin o webhook hacia MSS',
      'Misma autorización y auditoría'
    ],
    brandIds: [],
    integration: 'custom',
    notes: 'No es rehacer el sistema: es un traductor sobre la base multi-hardware.'
  }
];
