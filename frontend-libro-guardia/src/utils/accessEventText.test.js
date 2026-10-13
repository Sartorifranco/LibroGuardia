import { accessReasonText, countsAsPassage, passageDisplayName } from './accessEventText';

describe('nombre en el feed del guardia', () => {
  test('credencial desconocida sin nombre muestra DNI no registrado y el DNI enmascarado', () => {
    expect(passageDisplayName({
      name: '',
      accessReason: 'credencial_desconocida',
      idNumber: '30123456'
    })).toBe('DNI no registrado *****456');
    expect(passageDisplayName({
      name: '',
      reason: 'credencial_desconocida',
      idNumber: '*****456'
    })).toBe('DNI no registrado *****456');
  });

  test('puerta directa y lectura repetida se leen en español', () => {
    expect(accessReasonText('puerta_directa')).toBe('Acceso autorizado (puerta asignada).');
    expect(accessReasonText('lectura_repetida')).toBe('Lectura repetida (mismo paso).');
    expect(countsAsPassage({ accessReason: 'puerta_directa' })).toBe(true);
    expect(countsAsPassage({ accessReason: 'lectura_repetida' })).toBe(false);
    expect(countsAsPassage({ countsAsPassage: false })).toBe(false);
  });

  test('un nombre presente se respeta, y otro vacío sigue siendo Persona', () => {
    expect(passageDisplayName({ name: 'Ana', accessReason: 'credencial_desconocida' })).toBe('Ana');
    expect(passageDisplayName({ name: '', accessReason: 'puerta_no_autorizada' })).toBe('Persona');
  });
});
