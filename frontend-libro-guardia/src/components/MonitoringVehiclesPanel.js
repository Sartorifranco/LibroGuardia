import React, { useCallback, useEffect, useState } from 'react';
import { Car, Loader2, PlusCircle, Save, UserPlus } from 'lucide-react';
import { apiFetch } from '../services/api';

function MonitoringVehiclesPanel({ authToken, onSuccess, onError, onMovementRegistered }) {
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [plate, setPlate] = useState('');
  const [brand, setBrand] = useState('');
  const [company, setCompany] = useState('');
  const [driver, setDriver] = useState('');
  const [driverDni, setDriverDni] = useState('');
  const [companionName, setCompanionName] = useState('');
  const [companionDni, setCompanionDni] = useState('');
  const [companions, setCompanions] = useState([]);
  const [notes, setNotes] = useState('');
  const [insuranceExpiryDate, setInsuranceExpiryDate] = useState('');
  const [vtvExpiryDate, setVtvExpiryDate] = useState('');

  const loadVehicles = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const data = await apiFetch('/master-data/vehicles', { token: authToken });
      const filtered = (data.vehicles || []).filter((item) =>
        item.gateProfile === 'monitoreo' || !item.gateProfile
      );
      setVehicles(filtered);
    } catch (err) {
      onError?.(err.message);
    } finally {
      setLoading(false);
    }
  }, [authToken, onError]);

  useEffect(() => {
    loadVehicles();
  }, [loadVehicles]);

  const addCompanion = () => {
    if (!companionName.trim()) return;
    setCompanions((prev) => [...prev, { name: companionName.trim(), dni: companionDni.trim() }]);
    setCompanionName('');
    setCompanionDni('');
  };

  const registerMovement = async (vehicle, movementType) => {
    setSubmitting(true);
    try {
      const data = await apiFetch('/entries', {
        method: 'POST',
        token: authToken,
        body: {
          type: 'vehiculo',
          movementType,
          plate: vehicle.plate,
          brand: vehicle.brand,
          company: vehicle.company,
          driver: vehicle.driver,
          authorized: true,
          authorizedStatus: 'authorized',
          gateProfile: 'monitoreo',
          notes: `Registro Monitoreo${vehicle.companions?.length ? ` · Acompañantes: ${vehicle.companions.map((c) => c.name).join(', ')}` : ''}`
        }
      });
      onSuccess?.(`${movementType === 'ingreso' ? 'Ingreso' : 'Egreso'} registrado: ${vehicle.plate}`);
      onMovementRegistered?.(data.entry);
    } catch (err) {
      onError?.(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!plate.trim() || !driver.trim()) {
      onError?.('Patente y chofer son obligatorios.');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch('/master-data/vehicles/quick-authorize', {
        method: 'POST',
        token: authToken,
        body: {
          plate,
          brand,
          company,
          driver,
          driverDni,
          companions,
          notes,
          gateProfile: 'monitoreo',
          insuranceExpiryDate: insuranceExpiryDate || null,
          vtvExpiryDate: vtvExpiryDate || null
        }
      });
      onSuccess?.('Vehículo autorizado para ingreso por Monitoreo.');
      setPlate('');
      setBrand('');
      setCompany('');
      setDriver('');
      setDriverDni('');
      setCompanions([]);
      setNotes('');
      setInsuranceExpiryDate('');
      setVtvExpiryDate('');
      loadVehicles();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="monitoring-vehicles-panel">
      <section className="admin-sub-section">
        <h3 className="text-xl font-medium text-gray-800 mb-3 flex items-center gap-2">
          <Car size={20} /> Autorizar vehículo — Monitoreo
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          Registre autos autorizados con chofer y acompañantes para el portón de Monitoreo
          (livianos, directivos, clientes y grúas).
        </p>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input className="input-field" placeholder="Patente *" value={plate} onChange={(e) => setPlate(e.target.value)} required />
          <input className="input-field" placeholder="Marca / modelo" value={brand} onChange={(e) => setBrand(e.target.value)} />
          <input className="input-field" placeholder="Empresa / cliente" value={company} onChange={(e) => setCompany(e.target.value)} />
          <input className="input-field" placeholder="Chofer *" value={driver} onChange={(e) => setDriver(e.target.value)} required />
          <input className="input-field" placeholder="DNI chofer" value={driverDni} onChange={(e) => setDriverDni(e.target.value)} />
          <label className="text-sm text-gray-600">
            Venc. seguro (opcional)
            <input type="date" className="input-field mt-1" value={insuranceExpiryDate} onChange={(e) => setInsuranceExpiryDate(e.target.value)} />
          </label>
          <label className="text-sm text-gray-600">
            Venc. VTV (opcional)
            <input type="date" className="input-field mt-1" value={vtvExpiryDate} onChange={(e) => setVtvExpiryDate(e.target.value)} />
          </label>
          <input className="input-field md:col-span-2" placeholder="Notas" value={notes} onChange={(e) => setNotes(e.target.value)} />

          <div className="md:col-span-2 border rounded-md p-3 bg-gray-50">
            <p className="text-sm font-medium mb-2 flex items-center gap-2"><UserPlus size={16} /> Acompañantes</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <input className="input-field" placeholder="Nombre acompañante" value={companionName} onChange={(e) => setCompanionName(e.target.value)} />
              <input className="input-field" placeholder="DNI acompañante" value={companionDni} onChange={(e) => setCompanionDni(e.target.value)} />
              <button type="button" className="btn btn-secondary" onClick={addCompanion}>
                <PlusCircle size={16} /> Agregar
              </button>
            </div>
            {companions.length > 0 && (
              <ul className="mt-2 text-sm text-gray-700 space-y-1">
                {companions.map((item, index) => (
                  <li key={`${item.name}-${index}`}>
                    {item.name}{item.dni ? ` · DNI ${item.dni}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button type="submit" className="btn btn-primary md:col-span-2" disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
            {submitting ? 'Guardando...' : 'Autorizar vehículo'}
          </button>
        </form>
      </section>

      <section className="admin-sub-section">
        <h3 className="text-lg font-medium text-gray-800 mb-3">Vehículos autorizados hoy</h3>
        {loading ? (
          <p className="text-gray-500 flex items-center gap-2"><Loader2 className="animate-spin" size={16} /> Cargando...</p>
        ) : vehicles.length === 0 ? (
          <p className="text-gray-500">No hay vehículos precargados para Monitoreo.</p>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {vehicles.slice(0, 12).map((vehicle) => (
              <article key={vehicle.id} className="user-list-item">
                <div>
                  <p className="font-semibold text-gray-900">{vehicle.plate}</p>
                  <p className="text-sm text-gray-600">
                    {vehicle.brand || 'Sin marca'} · {vehicle.company || 'Sin empresa'}
                  </p>
                  <p className="text-sm text-gray-600">
                    Chofer: {vehicle.driver || '—'}
                    {vehicle.driverDni ? ` · DNI ${vehicle.driverDni}` : ''}
                  </p>
                  {Array.isArray(vehicle.companions) && vehicle.companions.length > 0 && (
                    <p className="text-sm text-gray-600">
                      Acompañantes: {vehicle.companions.map((c) => c.name).join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  <button type="button" className="btn btn-secondary-small" disabled={submitting} onClick={() => registerMovement(vehicle, 'ingreso')}>
                    Registrar ingreso
                  </button>
                  <button type="button" className="btn btn-secondary-small" disabled={submitting} onClick={() => registerMovement(vehicle, 'egreso')}>
                    Registrar egreso
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default MonitoringVehiclesPanel;
