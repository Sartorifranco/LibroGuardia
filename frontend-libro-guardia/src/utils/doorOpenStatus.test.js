import { doorOpenUserMessage, lastPulseStatusWord } from './doorOpenStatus';

describe('doorOpenStatus', () => {
  test('cola local no se muestra como puerta abierta', () => {
    expect(doorOpenUserMessage({
      message: 'Pedido enviado a la estación',
      via: 'local-queue',
      relay: { via: 'local-queue', command: 'queued' }
    }, 'Portón')).toBe('Portón: Enviado a la estación, abre en unos segundos');
  });

  test('relé confirmado se muestra como puerta abierta, sin la vía', () => {
    const text = doorOpenUserMessage({
      message: 'Portón abierta (vía nube)',
      relay: { triggered: true, via: 'tcp' }
    }, 'Portón');
    expect(text).toBe('Portón: Puerta abierta');
    expect(text).not.toMatch(/nube|local-queue|SR201|relé/i);
  });

  test('la placa no contestó: no dice puerta abierta', () => {
    const text = doorOpenUserMessage({
      relay: { triggered: true, via: 'tcp', confirmed: false }
    }, 'Portón');
    expect(text).toMatch(/no confirmó/);
    expect(text).not.toMatch(/Puerta abierta/);
  });

  test('si el backend no distingue, no dice OK', () => {
    expect(doorOpenUserMessage({ message: 'ok', via: 'cloud' })).toBe('Pedido enviado');
    expect(lastPulseStatusWord({ at: '2026-01-01T00:00:00.000Z', ok: true })).toBe('Pedido enviado');
    expect(lastPulseStatusWord({ ok: false })).toBe('Error');
    expect(lastPulseStatusWord({
      ok: true,
      via: 'local-queue',
      command: 'queued'
    })).toBe('Enviado a la estación');
  });

  test('último pulso usa el estado que guarda el backend', () => {
    expect(lastPulseStatusWord({ ok: true, relayVia: 'local-queue', relayStatus: 'en_cola' }))
      .toBe('Enviado a la estación');
    expect(lastPulseStatusWord({ ok: true, relayVia: 'tcp', relayStatus: 'confirmado', relayConfirmed: true }))
      .toBe('Abierta');
    expect(lastPulseStatusWord({ ok: true, relayVia: 'tcp', relayStatus: 'sin_confirmacion', relayConfirmed: false }))
      .toBe('Sin confirmación');
  });
});
