import fs from 'fs';
import path from 'path';
import { PERMISSION_LABELS, displayRoleLabel } from './permissions';
import { DOOR_ENTRY_ORIGIN_FILTERS } from './historialSections';

const FORBIDDEN = /SR201|relé|relevador|CH1|CH2|\bbridge\b|BioStar|Botonera/i;

describe('textos de operación', () => {
  test('los permisos que ve un supervisor no usan jerga', () => {
    Object.values(PERMISSION_LABELS).forEach((label) => {
      expect(label).not.toMatch(FORBIDDEN);
    });
  });

  test('el origen biométrico se llama lector biométrico', () => {
    const biostar = DOOR_ENTRY_ORIGIN_FILTERS.find((item) => item.id === 'biostar');
    expect(biostar.label).toBe('Lector biométrico');
    expect(biostar.label).not.toMatch(/BioStar/);
  });

  test('el rol crudo no se muestra', () => {
    expect(displayRoleLabel({ role: 'guardia' })).toBe('Guardia');
    expect(displayRoleLabel({ role: 'supervisor' })).toBe('Supervisor');
    expect(displayRoleLabel({ role: 'monitoreo' })).toBe('Monitoreo');
    expect(displayRoleLabel({ role: 'kiosk_puerta' })).toBe('Estación de acceso');
    expect(displayRoleLabel({ role: 'algo-raro' })).toBe('Operación');
    expect(displayRoleLabel({ role: 'guardia', roleLabel: 'Guardia de turno' })).toBe('Guardia de turno');
  });

  test('las pantallas de operación no muestran SR201 ni relé', () => {
    const files = [
      'components/DigitalDoorPanel.js',
      'components/ManualDoorButton.js',
      'components/AccessKiosk.js',
      'pages/Personal/PersonalPage.js',
      'context/EntriesContext.js',
      'utils/historialSections.js'
    ];
    files.forEach((rel) => {
      const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      const visible = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g, '');
      expect(visible).not.toMatch(/SR201|relevador|\brelé\b|CH1|CH2|BioStar/);
    });
  });
});
