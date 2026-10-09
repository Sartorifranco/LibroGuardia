import React from 'react';
import { render, screen } from '@testing-library/react';
import EntryNotes from './EntryNotes';

describe('avisos de un paso', () => {
  test('muestra el motivo y los warnings en español', () => {
    render(
      <EntryNotes
        entry={{
          accessReason: 'egreso_libre',
          accessAuthorized: true,
          warnings: [
            'paso_registrado_puerta_abierta',
            'egreso_sin_ingreso',
            'ingreso_duplicado',
            'estanco_esperar'
          ]
        }}
      />
    );

    expect(screen.getByText('Salida registrada.')).toBeInTheDocument();
    expect(screen.getByText('Paso registrado (puerta abierta)')).toBeInTheDocument();
    expect(screen.getByText('Salió sin registrar ingreso')).toBeInTheDocument();
    expect(screen.getByText('Ingreso duplicado')).toBeInTheDocument();
    expect(screen.getByText('Esperó: otra puerta del estanco abierta')).toBeInTheDocument();
  });
});
