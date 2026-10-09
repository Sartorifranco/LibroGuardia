'use strict';

/**
 * Códigos de motivo → mensaje corto para el guardia (sin jerga técnica).
 * Se conservan los `denialReason` / `accessReason` actuales (accessControl.js,
 * accessValidation.js, accessNominaMessages.js, visitasAccess.js, doorAccess.js)
 * para que reportes, filtros y la UI sigan funcionando.
 */

const REASONS = Object.freeze({
  // ── Autorizado ──
  acceso_total: 'Acceso autorizado.',
  nivel_acceso: 'Acceso autorizado.',
  puerta_directa: 'Acceso autorizado.',
  turno_hoy: 'Corresponde ingreso hoy según su turno.',
  citacion_hoy: 'Está citado hoy. Ingreso autorizado.',
  autorizacion_temporal: 'Autorización temporal vigente.',
  visita_autorizada: 'Visita autorizada.',
  pase_visita: 'Pase de visita válido.',
  egreso_libre: 'Salida registrada.',
  egreso_visita: 'Salida de visita registrada.',
  apertura_manual: 'Apertura manual.',
  apertura_remota: 'Apertura remota.',
  apertura_forzada_estanco: 'Apertura forzada del estanco (queda registrada).',
  paso_registrado_puerta_abierta: 'Paso registrado.',
  estanco_esperar: 'Esperá a que se cierre la otra puerta y volvé a escanear.',

  // ── Credencial ──
  credencial_desconocida: 'Credencial no registrada.',
  credencial_revocada: 'Credencial dada de baja.',
  dni_duplicado: 'DNI cargado en más de una persona. Avise a administración.',

  // ── Persona ──
  no_encontrado: 'Persona no encontrada.',
  persona_inactiva: 'Persona dada de baja.',
  fuera_de_vigencia: 'Acceso vencido o todavía no vigente.',

  // ── Puerta ──
  puerta_desconocida: 'Puerta no configurada.',
  puerta_deshabilitada: 'Puerta deshabilitada.',
  puerta_bloqueada: 'Puerta bloqueada (cierre total).',
  lado_no_habilitado: 'No se puede pasar por este lado de la puerta.',

  // ── Derechos ──
  puerta_no_autorizada: 'No autorizado para esta puerta.',
  fuera_de_horario: 'Fuera de su horario permitido.',
  feriado: 'Hoy es feriado: no tiene acceso.',
  fuera_horario_turno: 'Fuera del horario de su turno.',
  fuera_dia_turno: 'Hoy no le corresponde ingresar según su turno.',
  sin_turno: 'No tiene turno cargado. Consulte con administración.',
  sin_citacion_para_hoy: 'No tiene citación ni autorización para hoy.',
  visita_antes_de_ventana: 'La visita todavía no está habilitada (es más tarde).',
  visita_fuera_de_ventana: 'La visita está fuera de horario.',
  pase_vencido: 'El pase de visita está vencido.',
  pase_utilizado: 'El pase de visita ya fue usado.',
  pase_sin_ingreso: 'La visita no tiene ingreso registrado.',
  reloj_no_confiable: 'Hora del equipo no confiable: solo pasa personal con acceso permanente.',

  // ── Política ──
  requiere_aprobacion_guardia: 'Requiere aprobación del guardia.',

  // ── Estanco ──
  estanco_ocupado: 'Estanco ocupado: espere a que se cierre la otra puerta.',
  debe_ingresar_por_exterior: 'Debe pasar primero por la puerta exterior del estanco.',
  sin_permiso_forzar: 'No tiene permiso para forzar el estanco.',
  motivo_forzado_requerido: 'Indique el motivo para forzar el estanco.',

  // ── Anti-passback ──
  apb_violacion: 'Ya figura adentro de otra zona (anti-passback).',
  apb_advertencia: 'Aviso: no figura en la zona de la que sale (anti-passback).',
  apb_sin_presencia: 'Aviso: sin datos de presencia, no se controló el anti-passback.',

  // ── Avisos ──
  citacion_fuera_de_horario: 'Aviso: citación fuera del horario indicado.',
  intento_con_puerta_abierta: 'Aviso: intentó pasar con la puerta abierta.',
  egreso_sin_ingreso: 'Aviso: salió sin ingreso registrado.',
  ingreso_duplicado: 'Aviso: ya figuraba adentro.',
  posible_colado: 'Posible colado: salió sin ingreso registrado.',

  // ── Otros ──
  error_interno: 'Error del sistema. Intente de nuevo o avise a sistemas.',

  // ── Legado (siguen apareciendo en datos existentes) ──
  sin_citacion_hoy: 'No está citado hoy.',
  sistemas_acceso_permanente: 'Sistemas: acceso permanente.',
  ingreso_excepcional: 'Ingreso excepcional autorizado por guardia.',
  permanent: 'Autorización permanente.',
  citacion: 'Citación.',
  visita: 'Visita.',
  temporal: 'Autorización temporal.',
  visita_empleado: 'Visita de empleado.',
  visita_no_encontrada: 'Sin visita registrada.',
  visita_sin_fecha: 'La visita no tiene fecha cargada.',
  egreso: 'Salida registrada.'
});

/**
 * Códigos que produce el motor (decision.reason o warnings). Los de "Legado" y
 * error_interno (lo emite el adaptador ante una excepción) quedan solo para mostrar.
 */
const ENGINE_REASONS = Object.freeze(Object.keys(REASONS).filter((k) => ![
  'error_interno',
  'sin_citacion_hoy', 'sistemas_acceso_permanente', 'ingreso_excepcional', 'permanent', 'citacion',
  'visita', 'temporal', 'visita_empleado', 'visita_no_encontrada', 'visita_sin_fecha', 'egreso',
  // Los emite el hub al ingerir el paso (apbMonitor), no decide().
  'egreso_sin_ingreso', 'ingreso_duplicado', 'posible_colado'
].includes(k)));

const reasonMessage = (code) => REASONS[code] || 'Acceso denegado.';

module.exports = { REASONS, ENGINE_REASONS, reasonMessage };
