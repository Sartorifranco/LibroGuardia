/**
 * Plantillas de actuador de puerta (documentación de producto + defaults).
 * Alineado con DOOR_DRIVERS en doorsConfig y lib/doorDrivers/*.
 */

const ACTUATOR_TEMPLATES = [
  {
    id: 'sr201',
    name: 'Placa SR201',
    summary: 'Relé por red local (IP + canal). Estándar de planta MSS Guard.',
    fields: ['host', 'port', 'channel'],
    localPayload: { driver: 'sr201', host: '', port: 6722, channel: 1, pulseSeconds: 3 },
    howToConfigure: [
      'En Equipos de acceso → Puertas, elegí “Placa SR201”.',
      'Cargá la IP de la placa y el canal (1 o 2).',
      'Elegí si abre en planta (mini PC) o a distancia (túnel).'
    ]
  },
  {
    id: 'generic_http',
    name: 'Apertura por URL (HTTP)',
    summary: 'El sistema llama a una URL del equipo con { action, seconds }.',
    fields: ['httpUrl', 'httpMethod', 'httpAuthToken'],
    localPayload: {
      driver: 'generic_http',
      httpUrl: '',
      httpMethod: 'POST',
      httpAuthToken: '',
      pulseSeconds: 3
    },
    howToConfigure: [
      'En la puerta, elegí “Apertura por URL”.',
      'Pegá la URL que documenta el fabricante o la controladora.',
      'Opcional: token si el equipo lo pide.',
      'Probá la apertura desde Admin.'
    ]
  }
];

const getActuatorTemplate = (id) =>
  ACTUATOR_TEMPLATES.find((t) => t.id === id) || null;

module.exports = {
  ACTUATOR_TEMPLATES,
  getActuatorTemplate
};
