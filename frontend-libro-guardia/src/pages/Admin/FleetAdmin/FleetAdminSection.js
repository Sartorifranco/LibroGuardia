import React, { useCallback, useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { Upload } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import { AdminLoading, AdminTable } from '../../../components/admin/AdminUi';
import PageHeader from '../../../components/admin-ui/PageHeader';
import EmptyState from '../../../components/admin-ui/EmptyState';
import AdvancedSection from '../../../components/admin-ui/AdvancedSection';
import Modal from '../../../components/admin-ui/Modal';
import PageContainer from '../../../components/admin-ui/PageContainer';
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
  const { showSuccess, setError, showError } = useToast();

  const [selectedMobilesFile, setSelectedMobilesFile] = useState(null);
  const [selectedDriversFile, setSelectedDriversFile] = useState(null);
  const [movilesList, setMovilesList] = useState([]);
  const [driversList, setDriversList] = useState([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [mobilesOpen, setMobilesOpen] = useState(false);
  const [driversOpen, setDriversOpen] = useState(false);

  const loadLists = useCallback(async () => {
    if (!authToken || !hasPermission(currentUser, 'fleet.upload')) return;
    setLoadingLists(true);
    try {
      const [mobilesData, driversData] = await Promise.all([
        apiFetch('/fleet/mobiles', { token: authToken }),
        apiFetch('/fleet/drivers', { token: authToken })
      ]);
      setMovilesList((mobilesData.mobiles || []).map((m) => m.name).filter(Boolean));
      setDriversList((driversData.drivers || []).map((d) => d.name).filter(Boolean));
    } catch (err) {
      showError(err.message || 'No se pudieron cargar las listas de flota');
      setMovilesList([]);
      setDriversList([]);
    } finally {
      setLoadingLists(false);
    }
  }, [authToken, currentUser, showError]);

  useEffect(() => {
    loadLists();
  }, [loadLists]);

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

    if (!fileToUpload) {
      setError('Por favor, seleccione un archivo para subir.');
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

        showSuccess('Guardado');
        if (type === 'mobiles') setMobilesOpen(false);
        else setDriversOpen(false);
        await loadLists();
        setSelectedMobilesFile(null);
        setSelectedDriversFile(null);
      } catch (err) {
        console.error(`Error al procesar archivo de ${type}:`, err);
        setError(err.message || 'No pudimos leer la planilla. Revisá que tenga una columna con el nombre.');
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
    <PageContainer width="medium">
    <div className="admin-simple">
      <PageHeader
        title="Flota interna"
        purpose="Los móviles y los choferes de la empresa, para anotarlos cuando entran."
        howTo={[
          'Elegí la planilla de móviles o la de choferes.',
          'Cargala.',
          'Revisá que los nombres hayan quedado en la lista.'
        ]}
        action={(
          <button type="button" className="btn btn-primary" onClick={() => setMobilesOpen(true)}>
            <Upload size={20} /> Cargar móviles
          </button>
        )}
      />

      <div className="access-actions" style={{ marginBottom: '0.75rem' }}>
        <button type="button" className="btn btn-secondary" onClick={() => setDriversOpen(true)}>
          <Upload size={20} /> Cargar choferes
        </button>
      </div>

      <Modal
        open={mobilesOpen}
        title="Cargar móviles"
        description="Una planilla con un nombre por fila."
        onClose={() => setMobilesOpen(false)}
        size="sm"
        footer={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setMobilesOpen(false)}>Cancelar</button>
            <PendingButton
              type="button"
              actionId="upload-mobiles"
              pendingAction={pendingAction}
              className="btn btn-primary"
              disabled={!selectedMobilesFile}
              pendingLabel="Subiendo..."
              onClick={() => handleUploadFleetData('mobiles')}
            >
              Cargar
            </PendingButton>
          </>
        )}
      >
        <label htmlFor="uploadMobiles">
          Planilla de móviles
          <input type="file" id="uploadMobiles" accept=".csv, .xlsx" onChange={(e) => handleFileChange(e, 'mobiles')} className="input-field" />
        </label>
      </Modal>

      <Modal
        open={driversOpen}
        title="Cargar choferes"
        description="Una planilla con un nombre por fila."
        onClose={() => setDriversOpen(false)}
        size="sm"
        footer={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setDriversOpen(false)}>Cancelar</button>
            <PendingButton
              type="button"
              actionId="upload-drivers"
              pendingAction={pendingAction}
              className="btn btn-primary"
              disabled={!selectedDriversFile}
              pendingLabel="Subiendo..."
              onClick={() => handleUploadFleetData('drivers')}
            >
              Cargar
            </PendingButton>
          </>
        )}
      >
        <label htmlFor="uploadDrivers">
          Planilla de choferes
          <input type="file" id="uploadDrivers" accept=".csv, .xlsx" onChange={(e) => handleFileChange(e, 'drivers')} className="input-field" />
        </label>
      </Modal>

      {loadingLists ? (
        <AdminLoading label="Cargando la flota…" />
      ) : (
        <>
          {movilesList.length === 0 ? (
            <EmptyState
              title="Todavía no cargaste móviles"
              text="Un móvil es un vehículo de la empresa. La planilla trae un nombre por fila."
            />
          ) : (
            <AdminTable>
              <thead>
                <tr>
                  <th>Móvil</th>
                </tr>
              </thead>
              <tbody>
                {movilesList.map((name, idx) => (
                  <tr key={`mobile-${name}-${idx}`}>
                    <td>{name}</td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          )}
          {driversList.length === 0 ? (
            <EmptyState
              title="Todavía no cargaste choferes"
              text="El chofer es quien maneja el móvil. Se carga con otra planilla."
            />
          ) : (
            <AdminTable>
              <thead>
                <tr>
                  <th>Chofer</th>
                </tr>
              </thead>
              <tbody>
                {driversList.map((name, idx) => (
                  <tr key={`driver-${name}-${idx}`}>
                    <td>{name}</td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          )}
        </>
      )}

      <AdvancedSection>
        <p>La planilla tiene una columna llamada name, con un móvil o un chofer por fila.</p>
      </AdvancedSection>
    </div>
    </PageContainer>
  );
}

export default FleetAdminSection;
