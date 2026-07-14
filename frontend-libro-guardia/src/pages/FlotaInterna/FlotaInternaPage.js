import React, { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useClockPrefill } from '../../context/ClockPrefillContext';
import { useEntries } from '../../context/EntriesContext';
import { useToast } from '../../context/ToastContext';
import { apiFetch } from '../../services/api';

function FlotaInternaPage() {
  const { authToken, currentUser } = useAuth();
  const { addEntry, entriesLoading } = useEntries();
  const { showError } = useToast();
  const { prefill, consumePrefill } = useClockPrefill();
  const [movilesList, setMovilesList] = useState([]);
  const [driversList, setDriversList] = useState([]);
  const [flotaMobile, setFlotaMobile] = useState('');
  const [flotaDriver, setFlotaDriver] = useState('');
  const [flotaScheduledTime, setFlotaScheduledTime] = useState('');
  const [flotaActualTime, setFlotaActualTime] = useState('');
  const [flotaMovementType, setFlotaMovementType] = useState('ingreso');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!prefill || prefill.tab !== 'flota') return;
    const time = consumePrefill('flota');
    if (time) setFlotaActualTime(time);
  }, [prefill, consumePrefill]);

  useEffect(() => {
    const fetchFleetData = async () => {
      if (!currentUser || !authToken) {
        setMovilesList([]);
        setDriversList([]);
        return;
      }
      try {
        setLoading(true);
        const [mobilesData, driversData] = await Promise.all([
          apiFetch('/fleet/mobiles', { token: authToken }),
          apiFetch('/fleet/drivers', { token: authToken })
        ]);

        const mobiles = (mobilesData.mobiles || []).map((m) => m.name);
        const drivers = (driversData.drivers || []).map((d) => d.name);
        setMovilesList(mobiles);
        setDriversList(drivers);

        if (mobiles.length > 0 && !flotaMobile) {
          setFlotaMobile(mobiles[0]);
        }
        if (drivers.length > 0 && !flotaDriver) {
          setFlotaDriver(drivers[0]);
        }
      } catch (err) {
        console.error('Error al obtener datos de flota:', err);
        showError('Error al cargar la lista de móviles o choferes. Asegúrese de que el backend esté funcionando.');
      } finally {
        setLoading(false);
      }
    };

    fetchFleetData();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirror original: re-fetch when mobile/driver selection empty
  }, [currentUser, authToken]);

  const handleFlotaSubmit = async (e) => {
    e.preventDefault();
    if (!flotaMobile || !flotaDriver || !flotaScheduledTime || !flotaActualTime) {
      showError('Por favor, complete todos los campos de Flota.');
      return;
    }
    setLoading(true);
    try {
      await addEntry('flota', {
        movementType: flotaMovementType,
        mobile: flotaMobile,
        flotaDriver: flotaDriver,
        scheduledTime: flotaScheduledTime,
        actualTime: flotaActualTime,
      });
      setFlotaMobile(movilesList.length > 0 ? movilesList[0] : '');
      setFlotaDriver(driversList.length > 0 ? driversList[0] : '');
      setFlotaScheduledTime('');
      setFlotaActualTime('');
      setFlotaMovementType('ingreso');
    } finally {
      setLoading(false);
    }
  };

  const busy = loading || entriesLoading;

  return (
    <div className="form-section">
      <form onSubmit={handleFlotaSubmit} className="space-y-4">
        <h2 className="text-2xl font-semibold text-red-700 mb-4">Registro de Flota Interna</h2>
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label htmlFor="flotaMobile" className="block text-sm font-medium text-gray-700 mb-1">Móvil</label>
            <select id="flotaMobile" value={flotaMobile} onChange={(e) => setFlotaMobile(e.target.value)} className="input-field bg-white" required>
              {movilesList.map((mobile, index) => (
                <option key={index} value={mobile}>{mobile}</option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label htmlFor="flotaDriver" className="block text-sm font-medium text-gray-700 mb-1">Chofer</label>
            <select id="flotaDriver" value={flotaDriver} onChange={(e) => setFlotaDriver(e.target.value)} className="input-field bg-white" required>
              {driversList.map((driver, index) => (
                <option key={index} value={driver}>{driver}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label htmlFor="flotaScheduledTime" className="block text-sm font-medium text-gray-700 mb-1">Hora Programada</label>
            <input type="datetime-local" id="flotaScheduledTime" value={flotaScheduledTime} onChange={(e) => setFlotaScheduledTime(e.target.value)} className="input-field" required />
          </div>
          <div className="flex-1">
            <label htmlFor="flotaActualTime" className="block text-sm font-medium text-gray-700 mb-1">Hora Real</label>
            <input type="datetime-local" id="flotaActualTime" value={flotaActualTime} onChange={(e) => setFlotaActualTime(e.target.value)} className="input-field" required />
          </div>
        </div>
        <div>
          <label htmlFor="flotaMovementType" className="block text-sm font-medium text-gray-700 mb-1">Tipo de Movimiento</label>
          <select id="flotaMovementType" value={flotaMovementType} onChange={(e) => setFlotaMovementType(e.target.value)} className="input-field bg-white">
            <option value="ingreso">Ingreso</option>
            <option value="egreso">Egreso</option>
            <option value="ingreso auxilio">Ingreso Auxilio</option>
            <option value="egreso auxilio">Egreso Auxilio</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          <Save size={20} /> {busy ? 'Guardando...' : 'Registrar Flota'}
        </button>
      </form>
    </div>
  );
}

export default FlotaInternaPage;
