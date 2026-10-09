import React from 'react';
import { render, screen } from '@testing-library/react';
import DayPassages from './DayPassages';

const mockEntries = { entries: [], entriesLoading: false };

jest.mock('../context/EntriesContext', () => ({
  useEntries: () => mockEntries
}));

describe('feed de pasos del día', () => {
  test('muestra DNI no registrado con el documento enmascarado', () => {
    mockEntries.entries = [{
      id: 'e1',
      name: '',
      accessReason: 'credencial_desconocida',
      idNumber: '30123456',
      doorName: 'Exterior',
      movementType: 'ingreso',
      timestamp: '2026-10-09T15:00:00.000Z'
    }];
    render(<DayPassages />);
    expect(screen.getByText('DNI no registrado *****456')).toBeInTheDocument();
    expect(screen.queryByText('Persona')).not.toBeInTheDocument();
  });

  test('agrupa la lectura repetida bajo el mismo paso', () => {
    mockEntries.entries = [
      {
        id: 'e1',
        name: 'Ana',
        accessReason: 'puerta_directa',
        doorName: 'Exterior',
        movementType: 'ingreso',
        timestamp: '2026-10-09T15:00:00.000Z'
      },
      {
        id: 'e2',
        name: 'Ana',
        accessReason: 'lectura_repetida',
        repeatOf: 'e1',
        doorName: 'Exterior',
        movementType: 'ingreso',
        timestamp: '2026-10-09T15:00:06.000Z'
      }
    ];
    render(<DayPassages />);
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Ingreso')).toBeInTheDocument();
    expect(screen.getByText('Lectura repetida (mismo paso).')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });
});
