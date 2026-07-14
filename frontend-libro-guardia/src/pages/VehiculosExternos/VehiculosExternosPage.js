import React, { useEffect, useState } from 'react';
import { Save, Search, ShieldCheck, ShieldX } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useClockPrefill } from '../../context/ClockPrefillContext';
import { useEntries } from '../../context/EntriesContext';
import { useToast } from '../../context/ToastContext';
import { apiFetch, API_BASE_URL } from '../../services/api';
import { hasPermission } from '../../utils/permissions';

function VehiculosExternosPage() {
  const { authToken, currentUser } = useAuth();
  const { addEntry, entriesLoading } = useEntries();
  const { showSuccess, showError } = useToast();
  const { prefill, consumePrefill } = useClockPrefill();
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [vehicleBrand, setVehicleBrand] = useState('');
  const [vehicleCompany, setVehicleCompany] = useState('');
  const [vehicleDriver, setVehicleDriver] = useState('');
  const [vehicleType, setVehicleType] = useState('ingreso');
  const [vehicleEventTime, setVehicleEventTime] = useState('');
  const [vehicleLookupInfo, setVehicleLookupInfo] = useState(null);
  const [vehicleAuthStatus, setVehicleAuthStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!prefill || prefill.tab !== 'vehiculo') return;
    const time = consumePrefill('vehiculo');
    if (time) setVehicleEventTime(time);
  }, [prefill, consumePrefill]);

  const handleVehiclePlateChange = async (value) => {
    setVehiclePlate(value);
    setVehicleLookupInfo(null);
    if (!value.trim()) {
      setVehicleAuthStatus(null);
      return;
    }

    setVehicleAuthStatus('checking');
    try {
      const response = await fetch(`${API_BASE_URL}/master-data/vehicles/lookup?plate=${encodeURIComponent(value.trim())}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      setVehicleLookupInfo(data);
      if (response.ok && data.authorized) {
        setVehicleAuthStatus('authorized');
        if (data.vehicle) {
          setVehicleBrand(data.vehicle.brand || vehicleBrand);
          setVehicleCompany(data.vehicle.company || vehicleCompany);
          setVehicleDriver(data.vehicle.driver || vehicleDriver);
        }
      } else {
        setVehicleAuthStatus('not_authorized');
        if (data.vehicle) {
          setVehicleBrand(data.vehicle.brand || '');
          setVehicleCompany(data.vehicle.company || '');
          setVehicleDriver(data.vehicle.driver || '');
        }
      }
    } catch (err) {
      console.error('Error al consultar patente:', err);
      setVehicleAuthStatus(null);
    }
  };

  const handleQuickAuthorizeVehicle = async () => {
    if (!vehiclePlate.trim()) {
      showError('Ingrese una patente para autorizar.');
      return;
    }
    try {
      setLoading(true);
      await apiFetch('/master-data/vehicles/quick-authorize', {
        method: 'POST',
        token: authToken,
        body: {
          plate: vehiclePlate,
          brand: vehicleBrand,
          company: vehicleCompany,
          driver: vehicleDriver
        }
      });
      setVehicleAuthStatus('authorized');
      showSuccess('Vehículo autorizado correctamente.');
    } catch (err) {
      showError(err.message || 'Error en autorización rápida');
    } finally {
      setLoading(false);
    }
  };

  const handleVehicleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await addEntry('vehiculo', {
        movementType: vehicleType,
        plate: vehiclePlate,
        brand: vehicleBrand,
        company: vehicleCompany,
        driver: vehicleDriver,
        eventTime: vehicleEventTime,
        authorized: vehicleAuthStatus === 'authorized',
        authorizedStatus: vehicleAuthStatus || 'unknown'
      });
      setVehiclePlate('');
      setVehicleBrand('');
      setVehicleCompany('');
      setVehicleDriver('');
      setVehicleType('ingreso');
      setVehicleEventTime('');
      setVehicleAuthStatus(null);
      setVehicleLookupInfo(null);
    } finally {
      setLoading(false);
    }
  };

  const busy = loading || entriesLoading;

  return (
    <div className="form-section">
      <form onSubmit={handleVehicleSubmit} className="space-y-4">
        <div className="section-heading">
          <h2 className="text-2xl font-semibold text-red-700">Registro de Vehículos Externos</h2>
          <p className="text-sm text-gray-600">Consulte la patente para verificar autorización o autorice en el momento.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <label htmlFor="vehiclePlate" className="block text-sm font-medium text-gray-700 mb-1">Patente</label>
            <div className="flex gap-2">
              <input
                type="text"
                id="vehiclePlate"
                value={vehiclePlate}
                onChange={(e) => handleVehiclePlateChange(e.target.value)}
                className="input-field"
                placeholder="Ej: ABC123"
                required
              />
              <button type="button" className="btn btn-secondary" onClick={() => handleVehiclePlateChange(vehiclePlate)}>
                <Search size={18} />
              </button>
            </div>
            {vehicleAuthStatus === 'checking' && (
              <p className="text-sm text-gray-500 mt-2">Consultando autorización...</p>
            )}
            {vehicleAuthStatus === 'authorized' && (
              <div className="status-badge status-success mt-2">
                <ShieldCheck size={16} /> Vehículo autorizado
              </div>
            )}
            {vehicleAuthStatus === 'not_authorized' && (
              <div className="status-badge status-danger mt-2">
                <ShieldX size={16} /> {vehicleLookupInfo?.message || 'No autorizado en la base precargada'}
              </div>
            )}
            {vehicleLookupInfo?.vehicle && (
              <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm space-y-1">
                <p><strong>Registrado:</strong> {vehicleLookupInfo.vehicle.driver || 'Sin conductor cargado'}</p>
                <p><strong>Empresa:</strong> {vehicleLookupInfo.vehicle.company || '—'}</p>
                {vehicleLookupInfo.driverAccess && (
                  <p className={vehicleLookupInfo.driverAccess.authorized ? 'text-green-700' : 'text-red-700'}>
                    <strong>Conductor:</strong> {vehicleLookupInfo.driverMessage || (vehicleLookupInfo.driverAccess.authorized ? 'Habilitado para ingresar' : 'Sin autorización vigente')}
                  </p>
                )}
              </div>
            )}
          </div>
          <div>
            <label htmlFor="vehicleBrand" className="block text-sm font-medium text-gray-700 mb-1">Marca / Modelo</label>
            <input type="text" id="vehicleBrand" value={vehicleBrand} onChange={(e) => setVehicleBrand(e.target.value)} className="input-field" placeholder="Ej: Ford Ranger" />
          </div>
          <div>
            <label htmlFor="vehicleCompany" className="block text-sm font-medium text-gray-700 mb-1">Empresa</label>
            <input type="text" id="vehicleCompany" value={vehicleCompany} onChange={(e) => setVehicleCompany(e.target.value)} className="input-field" placeholder="Ej: Transportes Rápidos S.A." />
          </div>
          <div>
            <label htmlFor="vehicleDriver" className="block text-sm font-medium text-gray-700 mb-1">Conductor</label>
            <input type="text" id="vehicleDriver" value={vehicleDriver} onChange={(e) => setVehicleDriver(e.target.value)} className="input-field" placeholder="Ej: María López" />
          </div>
        </div>

        {vehicleAuthStatus === 'not_authorized' && hasPermission(currentUser, 'master.vehicles.quick_authorize') && (
          <button type="button" className="btn btn-secondary" onClick={handleQuickAuthorizeVehicle} disabled={busy}>
            <ShieldCheck size={18} /> Autorizar rápido y continuar
          </button>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="vehicleEventTime" className="block text-sm font-medium text-gray-700 mb-1">Hora del evento</label>
            <input type="time" id="vehicleEventTime" value={vehicleEventTime} onChange={(e) => setVehicleEventTime(e.target.value)} className="input-field" required />
          </div>
          <div>
            <label htmlFor="vehicleType" className="block text-sm font-medium text-gray-700 mb-1">Tipo de movimiento</label>
            <select id="vehicleType" value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} className="input-field bg-white">
              <option value="ingreso">Ingreso</option>
              <option value="egreso">Egreso</option>
            </select>
          </div>
        </div>

        <button type="submit" className="btn btn-primary w-full md:w-auto" disabled={busy}>
          <Save size={20} /> {busy ? 'Guardando...' : 'Registrar vehículo'}
        </button>
      </form>
    </div>
  );
}

export default VehiculosExternosPage;
