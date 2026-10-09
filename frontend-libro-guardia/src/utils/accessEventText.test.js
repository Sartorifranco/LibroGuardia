import { passageDisplayName } from './accessEventText';

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

  test('un nombre presente se respeta, y otro vacío sigue siendo Persona', () => {
    expect(passageDisplayName({ name: 'Ana', accessReason: 'credencial_desconocida' })).toBe('Ana');
    expect(passageDisplayName({ name: '', accessReason: 'puerta_no_autorizada' })).toBe('Persona');
  });
});
