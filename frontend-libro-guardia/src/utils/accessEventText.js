/**
 * Motivo de un paso, en español simple.
 * Misma tabla que el motor de acceso (reasons.es.js) para que la red local
 * y la nube digan lo mismo.
 */
const REASONS = {
  acceso_total: 'Acceso autorizado.',
  nivel_acceso: 'Acceso autorizado.',
  puerta_directa: 'Acceso autorizado (puerta asignada).',
  lectura_repetida: 'Lectura repetida (mismo paso).',
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
  credencial_desconocida: 'Credencial no registrada.',
  credencial_revocada: 'Credencial dada de baja.',
  dni_duplicado: 'DNI cargado en más de una persona. Avise a administración.',
  no_encontrado: 'Persona no encontrada.',
  persona_inactiva: 'Persona dada de baja.',
  fuera_de_vigencia: 'Acceso vencido o todavía no vigente.',
  puerta_desconocida: 'Puerta no configurada.',
  puerta_deshabilitada: 'Puerta deshabilitada.',
  puerta_bloqueada: 'Puerta bloqueada (cierre total).',
  lado_no_habilitado: 'No se puede pasar por este lado de la puerta.',
  puerta_no_autorizada: 'No autorizado para esta puerta.',
  fuera_de_horario: 'Fuera de su horario permitido.',
  feriado: 'Hoy es feriado: no tiene acceso.',
  fuera_horario_turno: 'Fuera del horario de su turno.',
  fuera_dia_turno: 'Hoy no le corresponde ingresar según su turno.',
  sin_turno: 'No tiene turno cargado. Consulte con administración.',
  sin_citacion_para_hoy: 'No tiene citación ni autorización para hoy.',
  visita_antes_de_ventana: 'La visita todavía no está habilitada.',
  visita_fuera_de_ventana: 'La visita está fuera de horario.',
  pase_vencido: 'El pase de visita está vencido.',
  pase_utilizado: 'El pase de visita ya fue usado.',
  pase_sin_ingreso: 'La visita no tiene ingreso registrado.',
  reloj_no_confiable: 'Hora del equipo no confiable: solo pasa personal con acceso permanente.',
  requiere_aprobacion_guardia: 'Requiere aprobación del guardia.',
  estanco_ocupado: 'Estanco ocupado: espere a que se cierre la otra puerta.',
  debe_ingresar_por_exterior: 'Debe pasar primero por la puerta exterior del estanco.',
  sin_permiso_forzar: 'No tiene permiso para forzar el estanco.',
  motivo_forzado_requerido: 'Indique el motivo para forzar el estanco.',
  apb_violacion: 'Ya figura adentro de otra zona.',
  apb_advertencia: 'Aviso: no figura en la zona de la que sale.',
  apb_sin_presencia: 'Aviso: sin datos de presencia.',
  citacion_fuera_de_horario: 'Aviso: citación fuera del horario indicado.',
  error_interno: 'Error del sistema. Intente de nuevo o avise a sistemas.',
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
  egreso: 'Salida registrada.',
  autorizado: 'Acceso autorizado.'
};

export const WARNING_TEXT = {
  paso_registrado_puerta_abierta: 'Paso registrado (puerta abierta)',
  egreso_sin_ingreso: 'Salió sin registrar ingreso',
  ingreso_duplicado: 'Ingreso duplicado',
  estanco_esperar: 'Esperó: otra puerta del estanco abierta'
};

export function accessReasonText(code) {
  const key = String(code || '').trim();
  if (!key) return '';
  if (REASONS[key]) return REASONS[key];
  if (WARNING_TEXT[key]) return WARNING_TEXT[key];
  if (/\s/.test(key)) return key;
  return '';
}

export function warningText(code) {
  const key = String(code || '').trim();
  if (!key) return '';
  return WARNING_TEXT[key] || accessReasonText(key);
}

export function entryMovement(entry = {}) {
  return String(entry.movementType || entry.tipoMovimiento || '').toLowerCase();
}

export function entryIdentity(entry = {}) {
  if (entry.id) return `id:${entry.id}`;
  if (entry.eventId) return `ev:${entry.eventId}`;
  return [
    entry.timestamp || '',
    entry.name || '',
    entry.doorId || '',
    entryMovement(entry),
    entry.idNumber || ''
  ].join('|');
}

export function normalizeAccessEntry(entry = {}) {
  const movementType = entry.movementType || entry.tipoMovimiento || '';
  return {
    ...entry,
    movementType,
    tipoMovimiento: entry.tipoMovimiento || movementType,
    warnings: Array.isArray(entry.warnings) ? entry.warnings : []
  };
}

/** Últimos 3 dígitos visibles: 30123456 → *****456. Si ya viene enmascarado, se deja. */
export function maskIdNumber(raw) {
  if (raw == null || raw === '') return '';
  const text = String(raw).trim();
  if (!text) return '';
  if (text.includes('*')) return text.slice(0, 20);
  const digits = text.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 3) return '*'.repeat(digits.length);
  return `${'*'.repeat(digits.length - 3)}${digits.slice(-3)}`;
}

/**
 * Nombre del feed. Credencial desconocida sin nombre: "DNI no registrado *****456".
 * El resto de los vacíos sigue como Persona.
 */
export function passageDisplayName(entry = {}) {
  const name = String(entry.name || entry.nameSnapshot || '').trim();
  if (name) return name;
  const reason = String(entry.accessReason || entry.denialReason || entry.reason || '').trim();
  if (reason !== 'credencial_desconocida') return 'Persona';
  const masked = maskIdNumber(entry.idNumber || entry.dniSnapshot || entry.idNumberMasked || '');
  if (masked && /\d/.test(masked)) return `DNI no registrado ${masked}`;
  return 'DNI no registrado';
}

/** Un paso de verdad. La lectura repetida es el mismo paso y no suma en los contadores. */
export function countsAsPassage(entry = {}) {
  if (entry && entry.countsAsPassage === false) return false;
  const reason = String(entry.accessReason || entry.denialReason || entry.reason || '').trim();
  return reason !== 'lectura_repetida';
}

export function movementVerb(entry = {}) {
  if (!countsAsPassage(entry)) return 'Lectura repetida (mismo paso).';
  const raw = entryMovement(entry);
  if (raw.includes('egreso') || raw.includes('salida')) return 'Egreso';
  if (raw.includes('ingreso')) return 'Ingreso';
  return 'Paso';
}
