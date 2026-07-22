import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { Upload, ClipboardList } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import { AdminBlock, AdminEmpty, AdminLoading } from '../../../components/admin/AdminUi';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';

/**
 * Sección "Nómina" del panel de administración.
 * @param {{ pendingAction: string|null, setPendingAction: Function }} props
 */
function NominaAdminSection({ pendingAction, setPendingAction }) {
  const { authToken, currentUser } = useAuth();
  const { setError, showSuccess } = useToast();

  const [loading, setLoading] = useState(false);
  const [selectedNominaFile, setSelectedNominaFile] = useState(null);
  const [nominaData, setNominaData] = useState([]);
  const [, setPersonalMasterData] = useState([]);

  useEffect(() => {
    const fetchNomina = async () => {
      if (!currentUser || !hasPermission(currentUser, 'master.nomina.read')) return;
      setLoading(true);
      try {
        const data = await apiFetch('/admin/nomina', { token: authToken, allowForbidden: true });
        setNominaData(data.personal || []);
      } catch (err) {
        console.error('Error al cargar nómina:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchNomina();
  }, [currentUser, authToken]);

  const handleFileChange = (e) => {
    setSelectedNominaFile(e.target.files[0]);
  };

  const parseNominaWorksheet = (worksheet) => {
    const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    const headerIndex = matrix.findIndex((row) => (
      row.some((cell) => String(cell).toLowerCase().includes('dni'))
      && row.some((cell) => String(cell).toLowerCase().includes('usuario'))
    ));
    if (headerIndex < 0) {
      throw new Error('No se encontraron encabezados Usuario/DNI en la planilla');
    }
    const headers = matrix[headerIndex].map((header) => String(header || '').trim());
    return matrix
      .slice(headerIndex + 1)
      .filter((row) => row.some((cell) => String(cell ?? '').trim()))
      .map((row) => {
        const item = {};
        headers.forEach((header, index) => {
          if (header) item[header] = row[index];
        });
        return item;
      });
  };

  const handleUploadNomina = async () => {
    if (!selectedNominaFile) {
      setError('Seleccione el archivo de nómina.');
      return;
    }
    setPendingAction('upload-nomina');
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const parsedData = parseNominaWorksheet(worksheet).map((row) => {
          const cleaned = { ...row };
          Object.entries(cleaned).forEach(([key, value]) => {
            if (/tipo.*autoriz/i.test(key) && String(value).length > 120) {
              cleaned[key] = String(value).slice(0, 120);
            }
          });
          return cleaned;
        });
        const result = await apiFetch('/admin/nomina/upload', {
          method: 'POST',
          token: authToken,
          body: { data: parsedData }
        });
        if ((result.imported ?? 0) === 0 && (result.total ?? 0) > 0) {
          const sample = (result.errors || []).slice(0, 3).map((e) => `${e.name}: ${e.reason}`).join(' · ');
          setError(result.message || `Ningún empleado importado${sample ? ` (${sample})` : ''}`);
        } else {
          showSuccess(result.message || 'Nómina importada');
        }
        setSelectedNominaFile(null);
        try {
          const listData = await apiFetch('/admin/nomina', { token: authToken, allowForbidden: true });
          setNominaData(listData.personal || []);
        } catch { /* ignore refresh */ }
        try {
          const personalPayload = await apiFetch('/master-data/personal', { token: authToken, allowForbidden: true });
          setPersonalMasterData(personalPayload.personal || []);
        } catch { /* ignore refresh */ }
      } catch (err) {
        setError(err.message || 'Error al procesar nómina');
      } finally {
        setPendingAction(null);
      }
    };
    reader.onerror = () => {
      setPendingAction(null);
      setError('No se pudo leer el archivo de nómina.');
    };
    reader.readAsArrayBuffer(selectedNominaFile);
  };

  if (!hasPermission(currentUser, 'master.nomina.write')) return null;

  return (
    <>
      <AdminBlock
        title="Importar nómina de personal"
        description="Excel con columnas Usuario, DNI, Legajo, Rol, C. Costo, Turno, Con citacion, Tipo de autorización. Actualiza empleados, turnos y autorizaciones permanentes."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="uploadNomina" className="block text-sm font-medium text-gray-700 mb-1">Archivo XLSX</label>
            <input
              type="file"
              id="uploadNomina"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100"
            />
            <PendingButton
              type="button"
              actionId="upload-nomina"
              pendingAction={pendingAction}
              className="btn btn-primary mt-2 w-full"
              disabled={!selectedNominaFile}
              pendingLabel="Importando..."
              onClick={handleUploadNomina}
            >
              <Upload size={20} /> Importar nómina
            </PendingButton>
          </div>
        </div>
      </AdminBlock>
      <AdminBlock title={`Empleados en nómina (${nominaData.length})`}>
        {loading ? (
          <AdminLoading label="Cargando nómina…" />
        ) : nominaData.length === 0 ? (
          <AdminEmpty
            icon={ClipboardList}
            title="Sin empleados cargados"
            description="Importá la planilla de nómina para ver el listado acá."
          />
        ) : (
          <div className="scroll-panel-max overflow-x-auto border border-gray-200 rounded-md">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-3 py-2 text-left text-xs uppercase">Nombre</th>
                  <th className="px-3 py-2 text-left text-xs uppercase">DNI</th>
                  <th className="px-3 py-2 text-left text-xs uppercase">Legajo</th>
                  <th className="px-3 py-2 text-left text-xs uppercase">Rol</th>
                  <th className="px-3 py-2 text-left text-xs uppercase">C. costo</th>
                  <th className="px-3 py-2 text-left text-xs uppercase">Turno</th>
                  <th className="px-3 py-2 text-left text-xs uppercase">Citación</th>
                  <th className="px-3 py-2 text-left text-xs uppercase">Autorización</th>
                </tr>
              </thead>
              <tbody>
                {nominaData.map((emp) => (
                  <tr key={emp.id || emp.legajoNormalized || emp.idNumberNormalized} className="border-t">
                    <td className="px-3 py-2">{emp.name}</td>
                    <td className="px-3 py-2">{emp.idNumberNormalized || emp.idNumber || '—'}</td>
                    <td className="px-3 py-2">{emp.legajoNormalized || emp.legajo || '—'}</td>
                    <td className="px-3 py-2">{emp.role || '—'}</td>
                    <td className="px-3 py-2">{emp.centroCosto || '—'}</td>
                    <td className="px-3 py-2">{emp.turnoRaw || '—'}</td>
                    <td className="px-3 py-2">{emp.requiresCitacion ? 'Sí' : 'No'}</td>
                    <td className="px-3 py-2">{emp.authorizationPolicy || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminBlock>
    </>
  );
}

export default NominaAdminSection;
