import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NovedadPage from './NovedadPage';

const mockAddEntry = jest.fn();

jest.mock('../../context/EntriesContext', () => ({
  useEntries: () => ({
    addEntry: mockAddEntry,
    entriesLoading: false
  }),
  wasEntryStored: (outcome) => outcome?.status === 'saved' || outcome?.status === 'queued'
}));

jest.mock('../../context/ClockPrefillContext', () => ({
  useClockPrefill: () => ({
    prefill: null,
    consumePrefill: jest.fn()
  })
}));

function fillForm() {
  fireEvent.change(screen.getByLabelText(/Descripción de la Novedad/i), {
    target: { value: 'Corte de luz en sector C' }
  });
  fireEvent.change(screen.getByLabelText(/Hora del Evento/i), {
    target: { value: '10:30' }
  });
}

describe('NovedadPage', () => {
  beforeEach(() => {
    mockAddEntry.mockReset();
  });

  test('conserva lo tipeado si el guardado falla', async () => {
    mockAddEntry.mockResolvedValue({ status: 'error' });
    render(<NovedadPage />);
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /Registrar Novedad/i }));

    await waitFor(() => expect(mockAddEntry).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Registrar Novedad/i })).toBeEnabled();
    });
    expect(screen.getByLabelText(/Descripción de la Novedad/i)).toHaveValue('Corte de luz en sector C');
    expect(screen.getByLabelText(/Hora del Evento/i)).toHaveValue('10:30');
  });

  test('vacía el formulario si quedó guardado o encolado', async () => {
    mockAddEntry.mockResolvedValue({ status: 'queued' });
    render(<NovedadPage />);
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /Registrar Novedad/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/Descripción de la Novedad/i)).toHaveValue('');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Registrar Novedad/i })).toBeEnabled();
    });
    expect(screen.getByLabelText(/Hora del Evento/i)).toHaveValue('');
  });
});
