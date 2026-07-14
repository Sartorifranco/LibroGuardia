import React, { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { useClockPrefill } from '../../context/ClockPrefillContext';
import { useEntries } from '../../context/EntriesContext';

function NovedadPage() {
  const { addEntry, entriesLoading } = useEntries();
  const { prefill, consumePrefill } = useClockPrefill();
  const [novedadDescription, setNovedadDescription] = useState('');
  const [novedadEventTime, setNovedadEventTime] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!prefill || prefill.tab !== 'novedad') return;
    const time = consumePrefill('novedad');
    if (time) setNovedadEventTime(time);
  }, [prefill, consumePrefill]);

  const handleNovedadSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await addEntry('novedad', {
        description: novedadDescription,
        eventTime: novedadEventTime,
      });
      setNovedadDescription('');
      setNovedadEventTime('');
    } finally {
      setLoading(false);
    }
  };

  const busy = loading || entriesLoading;

  return (
    <div className="form-section">
      <form onSubmit={handleNovedadSubmit} className="space-y-4">
        <h2 className="text-2xl font-semibold text-red-700 mb-4">Registro de Novedad</h2>
        <div>
          <label htmlFor="novedadDescription" className="block text-sm font-medium text-gray-700 mb-1">Descripción de la Novedad</label>
          <textarea id="novedadDescription" value={novedadDescription} onChange={(e) => setNovedadDescription(e.target.value)} rows="5" className="input-field resize-y" placeholder="Describa aquí la novedad: Ej. Corte de energía en sector C, Reparación de máquina X, Visita inesperada de..." required></textarea>
        </div>
        <div>
          <label htmlFor="novedadEventTime" className="block text-sm font-medium text-gray-700 mb-1">Hora del Evento</label>
          <input type="time" id="novedadEventTime" value={novedadEventTime} onChange={(e) => setNovedadEventTime(e.target.value)} className="input-field" required />
        </div>
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          <Save size={20} /> {busy ? 'Guardando...' : 'Registrar Novedad'}
        </button>
      </form>
    </div>
  );
}

export default NovedadPage;
