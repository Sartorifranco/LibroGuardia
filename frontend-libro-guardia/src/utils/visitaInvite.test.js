import {
  buildVisitaQrPayload,
  getVisitaWindow,
  hidePassCodeAsDni,
  maskDni,
  normalizeScanForSend
} from './visitaInvite';
import { parseScanData } from './dniParser';

const PASS = `MSSV1.${'A1'.repeat(16)}`;

describe('visitaInvite', () => {
  it('el QR es solo el código de pase, sin DNI ni nombre', () => {
    const raw = buildVisitaQrPayload({
      id: 'v1',
      dniVisitante: '27.762.583',
      nombreVisitante: 'Ramiro',
      passCode: PASS
    });
    expect(raw).toBe(PASS);
    expect(raw).not.toMatch(/27762583|Ramiro/);
  });

  it('sin código de pase válido no arma QR', () => {
    expect(buildVisitaQrPayload({ dniVisitante: '27762583' })).toBe('');
    expect(buildVisitaQrPayload({ passCode: 'MSSV1.123' })).toBe('');
  });

  it('enmascara el DNI dejando los últimos 3 dígitos', () => {
    expect(maskDni('27.762.583')).toBe('***583');
    expect(maskDni('')).toBe('');
  });

  it('el código escaneado se envía en mayúscula y un DNI queda igual', () => {
    expect(normalizeScanForSend(` ${PASS.toLowerCase()} `)).toBe(PASS);
    expect(normalizeScanForSend('30111222')).toBe('30111222');
  });

  it('no muestra el código de pase como DNI', () => {
    expect(hidePassCodeAsDni({ idNumber: PASS, name: 'Ana' })).toEqual({ idNumber: '', name: 'Ana' });
    expect(hidePassCodeAsDni({ idNumber: '30111222' }).idNumber).toBe('30111222');
  });

  it('el lector no confunde un código de pase con un DNI', () => {
    const parsed = parseScanData('MSSV1.1234567A00000000000000000000000B');
    expect(parsed.format).toBe('visita_pass');
    expect(parsed.idNumber).toBe('');
  });

  it('calcula ventana desde 2h antes hasta fin del día AR', () => {
    const windowInfo = getVisitaWindow('2026-07-28T14:30:00.000-03:00');
    expect(windowInfo.start).toBeInstanceOf(Date);
    expect(windowInfo.end).toBeInstanceOf(Date);
    expect(windowInfo.end.getTime()).toBeGreaterThan(windowInfo.start.getTime());
    expect(windowInfo.label).toMatch(/Válido desde/);
  });
});
