import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { PlusCircle, Trash2, Upload } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import PageHeader from '../../../components/admin-ui/PageHeader';
import EmptyState from '../../../components/admin-ui/EmptyState';
import AdvancedSection from '../../../components/admin-ui/AdvancedSection';
import Modal from '../../../components/admin-ui/Modal';
import PageContainer from '../../../components/admin-ui/PageContainer';
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
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);

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
        setFormOpen(false);
        showSuccess('Guardado');
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
        setError(err.message || 'No pudimos leer el archivo. Usá columnas Patente, Marca, Empresa y Conductor.');
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

  const visible = vehicleMasterData.filter((vehicle) => {
    const blob = `${vehicle.plate || ''} ${vehicle.brand || ''} ${vehicle.company || ''} ${vehicle.driver || ''}`.toLowerCase();
    return blob.includes(query.trim().toLowerCase());
  });

  return (
    <PageContainer width="medium">
    <div className="admin-simple">
      <PageHeader
        title="Vehículos"
        purpose="Los vehículos que pueden entrar, con patente, empresa y conductor."
        howTo={[
          'Completá la patente y, si la tenés, la marca y la empresa.',
          'Agregá el vehículo.',
          'Si son muchos, cargalos juntos desde Opciones avanzadas.'
        ]}
        action={(
          <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
            <PlusCircle size={18} /> Agregar vehículo
          </button>
        )}
      />
      <Modal
        open={formOpen}
        title="Agregar vehículo"
        description="Patente y, si la tenés, marca, empresa y conductor."
        onClose={() => setFormOpen(false)}
        dirty={Boolean(newVehiclePlate || newVehicleBrand || newVehicleCompany || newVehicleDriver)}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>Cancelar</button>
            <PendingButton type="submit" form="vehicle-form" actionId="saveVehicle" pendingAction={pendingAction} className="btn btn-primary" pendingLabel="Guardando...">
              Guardar
            </PendingButton>
          </>
        )}
      >
      <form id="vehicle-form" onSubmit={handleSavePreloadedVehicle} className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label>
          Patente
          <input type="text" aria-label="Patente" value={newVehiclePlate} onChange={(e) => setNewVehiclePlate(e.target.value)} className="input-field" required />
        </label>
        <label>
          Marca
          <input type="text" aria-label="Marca" value={newVehicleBrand} onChange={(e) => setNewVehicleBrand(e.target.value)} className="input-field" />
        </label>
        <label>
          Empresa
          <input type="text" aria-label="Empresa del vehículo" value={newVehicleCompany} onChange={(e) => setNewVehicleCompany(e.target.value)} className="input-field" />
        </label>
        <label>
          Conductor
          <input type="text" aria-label="Conductor" value={newVehicleDriver} onChange={(e) => setNewVehicleDriver(e.target.value)} className="input-field" />
        </label>
        <label className="text-sm">
          Vencimiento del seguro
          <input type="date" aria-label="Vencimiento del seguro" value={newVehicleInsuranceExpiry} onChange={(e) => setNewVehicleInsuranceExpiry(e.target.value)} className="input-field mt-1" />
        </label>
        <label className="text-sm">
          Vencimiento de la VTV
          <input type="date" aria-label="Vencimiento de la VTV" value={newVehicleVtvExpiry} onChange={(e) => setNewVehicleVtvExpiry(e.target.value)} className="input-field mt-1" />
        </label>
      </form>
      </Modal>

      <div className="admin-simple-search">
        <input className="input-field" type="search" aria-label="Buscar vehículo" placeholder="Buscar por patente, marca o empresa" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={vehicleMasterData.length === 0 ? 'Todavía no cargaste vehículos' : 'Ningún vehículo coincide'}
          text={vehicleMasterData.length === 0
            ? 'Un vehículo autorizado puede entrar cuando el guardia anota la patente.'
            : 'Probá con otra patente.'}
          actionLabel={vehicleMasterData.length === 0 ? 'Cargar el primero' : undefined}
          onAction={vehicleMasterData.length === 0 ? () => setFormOpen(true) : undefined}
        />
      ) : (
        <>
          <div className="admin-simple-table-wrap">
            <table className="min-w-full text-sm">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left">Patente</th>
                  <th className="px-3 py-2 text-left">Marca</th>
                  <th className="px-3 py-2 text-left">Empresa</th>
                  <th className="px-3 py-2 text-left">Conductor</th>
                  <th className="px-3 py-2 text-left">Seguro</th>
                  <th className="px-3 py-2 text-left">VTV</th>
                  <th className="px-3 py-2 text-left">Acción</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((vehicle) => (
                  <tr key={vehicle.id}>
                    <td className="px-3 py-2">{vehicle.plate}</td>
                    <td className="px-3 py-2">{vehicle.brand}</td>
                    <td className="px-3 py-2">{vehicle.company}</td>
                    <td className="px-3 py-2">{vehicle.driver}</td>
                    <td className="px-3 py-2">{vehicle.insuranceExpiryDate || '—'}</td>
                    <td className="px-3 py-2">{vehicle.vtvExpiryDate || '—'}</td>
                    <td className="px-3 py-2">
                      <button type="button" className="btn btn-danger-small" aria-label={`Quitar ${vehicle.plate}`} onClick={() => handleDeletePreloadedVehicle(vehicle.id)}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-simple-cards">
            {visible.map((vehicle) => (
              <article key={`card-${vehicle.id}`} className="admin-simple-card">
                <strong>{vehicle.plate}</strong>
                <p>{vehicle.brand || 'Sin marca'} · {vehicle.company || 'Sin empresa'}</p>
                <p>{vehicle.driver || 'Sin conductor'}</p>
                <div className="admin-simple-card__actions">
                  <button type="button" className="btn btn-danger-small" aria-label={`Quitar ${vehicle.plate}`} onClick={() => handleDeletePreloadedVehicle(vehicle.id)}>Quitar</button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      <AdvancedSection>
        <label htmlFor="uploadVehicles" className="block text-sm font-medium mb-1">Cargar varios desde una planilla</label>
        <p className="historial-meta">Columnas: Patente, Marca, Empresa y Conductor.</p>
        <input type="file" id="uploadVehicles" accept=".csv, .xlsx" onChange={handleFileChange} className="input-field" />
        <PendingButton
          type="button"
          actionId="upload-vehicles"
          pendingAction={pendingAction}
          className="btn btn-secondary mt-2"
          disabled={!selectedVehiclesFile}
          pendingLabel="Subiendo..."
          onClick={handleUploadVehicles}
        >
          <Upload size={20} /> Cargar la planilla
        </PendingButton>
      </AdvancedSection>
    </div>
    </PageContainer>
  );
}

export default VehiclesAdminSection;
