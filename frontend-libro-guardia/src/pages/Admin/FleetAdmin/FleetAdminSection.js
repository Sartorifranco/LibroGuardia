import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { Upload } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';

/**
 * Sección "Flota interna" (móviles y choferes) del panel de administración.
 * @param {{ setPendingAction: Function, pendingAction: string|null }} props
 */
function FleetAdminSection({ pendingAction, setPendingAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, setError } = useToast();

  const [selectedMobilesFile, setSelectedMobilesFile] = useState(null);
  const [selectedDriversFile, setSelectedDriversFile] = useState(null);
  const [, setMovilesList] = useState([]);
  const [, setDriversList] = useState([]);

  const handleFileChange = (e, type) => {
    if (type === 'mobiles') {
      setSelectedMobilesFile(e.target.files[0]);
    } else if (type === 'drivers') {
      setSelectedDriversFile(e.target.files[0]);
    }
  };

  const handleUploadFleetData = async (type) => {
    const fileToUpload = type === 'mobiles' ? selectedMobilesFile : selectedDriversFile;
    const endpoint = type === 'mobiles' ? '/admin/fleet/mobiles/upload' : '/admin/fleet/drivers/upload';
    const successMessage = type === 'mobiles'
      ? 'Lista de móviles actualizada exitosamente.'
      : 'Lista de choferes actualizada exitosamente.';

    if (!fileToUpload) {
      setError("Por favor, seleccione un archivo para subir.");
      return;
    }

    setError(null);
    setPendingAction(`upload-${type}`);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(worksheet);
        const parsedData = json.map((row) => ({ name: row.name }));

        await apiFetch(endpoint, {
          method: 'POST',
          token: authToken,
          body: { data: parsedData }
        });

        showSuccess(successMessage);
        const [mobilesData, driversData] = await Promise.all([
          apiFetch('/fleet/mobiles', { token: authToken }),
          apiFetch('/fleet/drivers', { token: authToken })
        ]);
        setMovilesList(mobilesData.mobiles.map(m => m.name));
        setDriversList(driversData.drivers.map(d => d.name));
        setSelectedMobilesFile(null);
        setSelectedDriversFile(null);
      } catch (err) {
        console.error(`Error al procesar archivo de ${type}:`, err);
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

  if (!hasPermission(currentUser, 'fleet.upload')) return null;

  return (
    <div className="admin-sub-section">
      <h3 className="text-xl font-medium text-gray-800 mb-3 flex items-center gap-2"><Upload size={20} /> Cargar listas de flota interna</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="uploadMobiles" className="block text-sm font-medium text-gray-700 mb-1">Subir móviles (CSV/XLSX)</label>
          <input type="file" id="uploadMobiles" accept=".csv, .xlsx" onChange={(e) => handleFileChange(e, 'mobiles')} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
          <PendingButton
            type="button"
            actionId="upload-mobiles"
            pendingAction={pendingAction}
            className="btn btn-secondary mt-2 w-full"
            disabled={!selectedMobilesFile}
            pendingLabel="Subiendo..."
            onClick={() => handleUploadFleetData('mobiles')}
          >
            <Upload size={20} /> Cargar móviles
          </PendingButton>
        </div>
        <div>
          <label htmlFor="uploadDrivers" className="block text-sm font-medium text-gray-700 mb-1">Subir choferes (CSV/XLSX)</label>
          <input type="file" id="uploadDrivers" accept=".csv, .xlsx" onChange={(e) => handleFileChange(e, 'drivers')} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
          <PendingButton
            type="button"
            actionId="upload-drivers"
            pendingAction={pendingAction}
            className="btn btn-secondary mt-2 w-full"
            disabled={!selectedDriversFile}
            pendingLabel="Subiendo..."
            onClick={() => handleUploadFleetData('drivers')}
          >
            <Upload size={20} /> Cargar choferes
          </PendingButton>
        </div>
      </div>
    </div>
  );
}

export default FleetAdminSection;
