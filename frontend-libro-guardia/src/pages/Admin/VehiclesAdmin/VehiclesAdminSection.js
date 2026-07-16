import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { PlusCircle, Trash2, Upload } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';

/**
 * Sección "Vehículos" del panel de administración.
 * @param {{ pendingAction: string|null, runAction: Function, setPendingAction: Function }} props
 */
function VehiclesAdminSection({ pendingAction, runAction, setPendingAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError, setError } = useToast();
  const { confirm } = useConfirm();

  const [vehicleMasterData, setVehicleMasterData] = useState([]);
  const [selectedVehiclesFile, setSelectedVehiclesFile] = useState(null);
  const [newVehiclePlate, setNewVehiclePlate] = useState('');
  const [newVehicleBrand, setNewVehicleBrand] = useState('');
  const [newVehicleCompany, setNewVehicleCompany] = useState('');
  const [newVehicleDriver, setNewVehicleDriver] = useState('');
  const [newVehicleInsuranceExpiry, setNewVehicleInsuranceExpiry] = useState('');
  const [newVehicleVtvExpiry, setNewVehicleVtvExpiry] = useState('');

  useEffect(() => {
    const fetchVehicleMasterData = async () => {
      if (!currentUser || !hasPermission(currentUser, 'master.vehicles.read')) {
        setVehicleMasterData([]);
        return;
      }
      try {
        const data = await apiFetch('/master-data/vehicles', { token: authToken, allowForbidden: true });
        setVehicleMasterData(data.vehicles || []);
      } catch (err) {
        console.error('Error al cargar vehículos autorizados:', err);
      }
    };
    fetchVehicleMasterData();
  }, [currentUser, authToken]);

  const handleSavePreloadedVehicle = async (e) => {
    e.preventDefault();
    await runAction('saveVehicle', async () => {
      try {
        const data = await apiFetch('/master-data/vehicles', {
          method: 'POST',
          token: authToken,
          body: {
            plate: newVehiclePlate,
            brand: newVehicleBrand,
            company: newVehicleCompany,
            driver: newVehicleDriver,
            authorized: true,
            insuranceExpiryDate: newVehicleInsuranceExpiry || null,
            vtvExpiryDate: newVehicleVtvExpiry || null
          }
        });
        setNewVehiclePlate('');
        setNewVehicleBrand('');
        setNewVehicleCompany('');
        setNewVehicleDriver('');
        setNewVehicleInsuranceExpiry('');
        setNewVehicleVtvExpiry('');
        showSuccess('Vehículo precargado correctamente.');
        setVehicleMasterData((prev) => {
          const filtered = prev.filter((item) => item.plateNormalized !== data.vehicle.plateNormalized);
          return [...filtered, data.vehicle];
        });
      } catch (err) {
        showError(err.message || 'Error al precargar vehículo');
      }
    });
  };

  const handleDeletePreloadedVehicle = async (id) => {
    const ok = await confirm({
      title: 'Eliminar vehículo',
      message: 'Se quitará de la base autorizada. Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await apiFetch(`/master-data/vehicles/${id}`, {
        method: 'DELETE',
        token: authToken
      });
      setVehicleMasterData((prev) => prev.filter((item) => item.id !== id));
      showSuccess('Vehículo eliminado de la base autorizada.');
    } catch (err) {
      showError(err.message || 'Error al eliminar vehículo');
    }
  };

  const handleFileChange = (e) => {
    setSelectedVehiclesFile(e.target.files[0]);
  };

  const handleUploadVehicles = async () => {
    const fileToUpload = selectedVehiclesFile;
    if (!fileToUpload) {
      setError("Por favor, seleccione un archivo para subir.");
      return;
    }

    setError(null);
    setPendingAction('upload-vehicles');

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(worksheet);

        const parsedData = json.map((row) => ({
          plate: row.plate || row.patente || row.Patente,
          brand: row.brand || row.marca || row.Marca,
          company: row.company || row.empresa || row.Empresa,
          driver: row.driver || row.conductor || row.Conductor,
          authorized: row.authorized !== false && row.autorizado !== false
        }));

        await apiFetch('/admin/fleet/vehicles/upload', {
          method: 'POST',
          token: authToken,
          body: { data: parsedData }
        });

        showSuccess('Vehículos autorizados cargados exitosamente.');
        try {
          const vehiclesData = await apiFetch('/master-data/vehicles', { token: authToken, allowForbidden: true });
          setVehicleMasterData(vehiclesData.vehicles || []);
        } catch { /* ignore */ }
        setSelectedVehiclesFile(null);
      } catch (err) {
        console.error('Error al procesar archivo de vehicles:', err);
        setError(err.message || `Error al procesar el archivo. Asegúrese de que el formato sea correcto (CSV/XLSX con una columna 'name').`);
      } finally {
        setPendingAction(null);
      }
    };
    reader.onerror = () => {
      setPendingAction(null);
      setError('No se pudo leer el archivo seleccionado.');
    };
    reader.readAsArrayBuffer(fileToUpload);
  };

  if (!hasPermission(currentUser, 'master.vehicles.write')) return null;

  return (
    <>
      <div className="admin-sub-section">
        <h3 className="text-xl font-medium text-gray-800 mb-3">Precarga de vehículos autorizados</h3>
        <form onSubmit={handleSavePreloadedVehicle} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
          <input type="text" value={newVehiclePlate} onChange={(e) => setNewVehiclePlate(e.target.value)} className="input-field" placeholder="Patente" required />
          <input type="text" value={newVehicleBrand} onChange={(e) => setNewVehicleBrand(e.target.value)} className="input-field" placeholder="Marca / modelo" />
          <input type="text" value={newVehicleCompany} onChange={(e) => setNewVehicleCompany(e.target.value)} className="input-field" placeholder="Empresa" />
          <input type="text" value={newVehicleDriver} onChange={(e) => setNewVehicleDriver(e.target.value)} className="input-field" placeholder="Conductor" />
          <label className="text-sm text-gray-600 md:col-span-1">
            Venc. seguro (opcional)
            <input type="date" value={newVehicleInsuranceExpiry} onChange={(e) => setNewVehicleInsuranceExpiry(e.target.value)} className="input-field mt-1" />
          </label>
          <label className="text-sm text-gray-600 md:col-span-1">
            Venc. VTV (opcional)
            <input type="date" value={newVehicleVtvExpiry} onChange={(e) => setNewVehicleVtvExpiry(e.target.value)} className="input-field mt-1" />
          </label>
          <PendingButton type="submit" actionId="saveVehicle" pendingAction={pendingAction} className="btn btn-primary xl:col-span-4" pendingLabel="Guardando...">
            <PlusCircle size={18} /> Agregar vehículo autorizado
          </PendingButton>
        </form>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="uploadVehicles" className="block text-sm font-medium text-gray-700 mb-1">Carga masiva (XLSX/CSV)</label>
            <input type="file" id="uploadVehicles" accept=".csv, .xlsx" onChange={handleFileChange} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
            <PendingButton
              type="button"
              actionId="upload-vehicles"
              pendingAction={pendingAction}
              className="btn btn-secondary mt-2 w-full"
              disabled={!selectedVehiclesFile}
              pendingLabel="Subiendo..."
              onClick={handleUploadVehicles}
            >
              <Upload size={20} /> Cargar vehículos
            </PendingButton>
          </div>
        </div>
      </div>
      <div className="admin-sub-section">
        <h3 className="text-xl font-medium text-gray-800 mb-3">Base actual ({vehicleMasterData.length})</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-4 py-2 text-left text-xs uppercase">Patente</th>
                <th className="px-4 py-2 text-left text-xs uppercase">Marca</th>
                <th className="px-4 py-2 text-left text-xs uppercase">Empresa</th>
                <th className="px-4 py-2 text-left text-xs uppercase">Conductor</th>
                <th className="px-4 py-2 text-left text-xs uppercase">Seguro</th>
                <th className="px-4 py-2 text-left text-xs uppercase">VTV</th>
                <th className="px-4 py-2 text-left text-xs uppercase">Estado</th>
                <th className="px-4 py-2 text-left text-xs uppercase">Acción</th>
              </tr>
            </thead>
            <tbody>
              {vehicleMasterData.map((vehicle) => (
                <tr key={vehicle.id} className="border-t">
                  <td className="px-4 py-2">{vehicle.plate}</td>
                  <td className="px-4 py-2">{vehicle.brand}</td>
                  <td className="px-4 py-2">{vehicle.company}</td>
                  <td className="px-4 py-2">{vehicle.driver}</td>
                  <td className="px-4 py-2">{vehicle.insuranceExpiryDate || '—'}</td>
                  <td className="px-4 py-2">{vehicle.vtvExpiryDate || '—'}</td>
                  <td className="px-4 py-2">{vehicle.authorized !== false ? 'Autorizado' : 'No autorizado'}</td>
                  <td className="px-4 py-2">
                    <button type="button" className="btn btn-danger-small" onClick={() => handleDeletePreloadedVehicle(vehicle.id)}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default VehiclesAdminSection;
