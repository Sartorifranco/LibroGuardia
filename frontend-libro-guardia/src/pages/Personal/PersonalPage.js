import React, { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import EmployeeNominaCard from '../../components/EmployeeNominaCard';
import { useAuth } from '../../context/AuthContext';
import { useClockPrefill } from '../../context/ClockPrefillContext';
import { useEntries } from '../../context/EntriesContext';
import { useToast } from '../../context/ToastContext';
import { apiFetch } from '../../services/api';
import { hasPermission } from '../../utils/permissions';

function PersonalPage() {
  const { authToken, currentUser } = useAuth();
  const { addEntry, reloadEntries, entriesLoading } = useEntries();
  const { showSuccess, showError } = useToast();
  const { prefill, consumePrefill } = useClockPrefill();

  const [personalAllowOverride, setPersonalAllowOverride] = useState(false);
  const [personalAccessStatus, setPersonalAccessStatus] = useState(null);
  const [personalNominaProfile, setPersonalNominaProfile] = useState(null);
  const [personalExceptionalReason, setPersonalExceptionalReason] = useState('');
  const [personalName, setPersonalName] = useState('');
  const [personalId, setPersonalId] = useState('');
  const [personalCompany, setPersonalCompany] = useState('');
  const [personalDestination, setPersonalDestination] = useState('');
  const [personalType, setPersonalType] = useState('ingreso');
  const [personalEventTime, setPersonalEventTime] = useState('');
  const [personalArtExpiry, setPersonalArtExpiry] = useState('');
  const [personalLicenseExpiry, setPersonalLicenseExpiry] = useState('');
  const [personalMasterData, setPersonalMasterData] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!prefill || prefill.tab !== 'personal') return;
    const time = consumePrefill('personal');
    if (time) setPersonalEventTime(time);
  }, [prefill, consumePrefill]);

  useEffect(() => {
    const fetchPersonalMasterData = async () => {
      if (!currentUser || !authToken) {
        setPersonalMasterData([]);
        return;
      }
      try {
        setLoading(true);
        const data = await apiFetch('/master-data/personal', { token: authToken });
        setPersonalMasterData(data.personal || []);
      } catch (err) {
        console.error('Error al obtener datos maestros de personal:', err);
        showError('Error al cargar la base de datos de personal. Asegúrese de que el backend esté funcionando.');
      } finally {
        setLoading(false);
      }
    };

    fetchPersonalMasterData();
  }, [currentUser, authToken, showError]);

  const handlePersonalNameChange = (e) => {
    const name = e.target.value;
    setPersonalName(name);

    const foundPerson = personalMasterData.find(
      (person) => person.name.toLowerCase() === name.toLowerCase()
    );

    if (foundPerson) {
      setPersonalId(foundPerson.idNumber || '');
      setPersonalCompany(foundPerson.company || '');
      setPersonalDestination(foundPerson.destination || '');
      setPersonalArtExpiry(foundPerson.artExpiryDate || '');
      setPersonalLicenseExpiry(foundPerson.licenseExpiryDate || '');
    } else {
      setPersonalId('');
      setPersonalCompany('');
      setPersonalDestination('');
      setPersonalArtExpiry('');
      setPersonalLicenseExpiry('');
    }
  };

  const handlePersonalIdChange = async (value) => {
    setPersonalId(value);
    const normalized = value.replace(/\D/g, '');
    if (normalized.length < 7) {
      setPersonalAccessStatus(null);
      setPersonalNominaProfile(null);
      return;
    }

    const localMatch = personalMasterData.find(
      (person) => String(person.idNumber || '').replace(/\D/g, '') === normalized
    );
    if (localMatch) {
      setPersonalName(localMatch.name || '');
      setPersonalCompany(localMatch.company || localMatch.centroCosto || '');
      setPersonalDestination(localMatch.destination || localMatch.centroCosto || '');
      setPersonalArtExpiry(localMatch.artExpiryDate || '');
      setPersonalLicenseExpiry(localMatch.licenseExpiryDate || '');
      setPersonalNominaProfile(localMatch);
    } else if (hasPermission(currentUser, 'master.personal.read') && authToken) {
      try {
        const data = await apiFetch(`/master-data/personal/by-dni/${normalized}`, { token: authToken });
        const profile = data.personal;
        setPersonalNominaProfile(profile);
        setPersonalName(profile.name || '');
        setPersonalCompany(profile.company || profile.centroCosto || '');
        setPersonalDestination(profile.destination || profile.centroCosto || '');
        setPersonalArtExpiry(profile.artExpiryDate || '');
        setPersonalLicenseExpiry(profile.licenseExpiryDate || '');
      } catch {
        setPersonalNominaProfile(null);
      }
    }

    if (hasPermission(currentUser, 'master.citaciones.read') && authToken) {
      try {
        const params = new URLSearchParams({
          dni: normalized,
          name: personalName || localMatch?.name || ''
        });
        const data = await apiFetch(`/guard/access-status?${params}`, { token: authToken });
        setPersonalAccessStatus(data);
      } catch {
        setPersonalAccessStatus(null);
      }
    }
  };

  const resetPersonalForm = () => {
    setPersonalName('');
    setPersonalId('');
    setPersonalCompany('');
    setPersonalDestination('');
    setPersonalType('ingreso');
    setPersonalEventTime('');
    setPersonalArtExpiry('');
    setPersonalLicenseExpiry('');
    setPersonalAllowOverride(false);
    setPersonalAccessStatus(null);
    setPersonalNominaProfile(null);
    setPersonalExceptionalReason('');
  };

  const handleExceptionalPersonalSubmit = async () => {
    if (!personalExceptionalReason.trim()) {
      showError('Indique el motivo del ingreso excepcional');
      return;
    }
    try {
      setLoading(true);
      const data = await apiFetch('/guard/exceptional-entry', {
        method: 'POST',
        token: authToken,
        body: {
          name: personalName,
          idNumber: personalId,
          company: personalCompany,
          destination: personalDestination,
          eventTime: personalEventTime,
          reason: personalExceptionalReason.trim(),
          movementType: personalType
        }
      });
      showSuccess(data.message || 'Ingreso excepcional registrado.');
      resetPersonalForm();
      await reloadEntries(true);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePersonalSubmit = async (e) => {
    e.preventDefault();

    const personExistsInMaster = personalMasterData.some(
      (person) => person.name.toLowerCase() === personalName.toLowerCase()
    );

    try {
      setLoading(true);
      await apiFetch('/master-data/personal', {
        method: 'POST',
        token: authToken,
        body: {
          name: personalName,
          idNumber: personalId,
          company: personalCompany,
          destination: personalDestination,
          artExpiryDate: personalArtExpiry || null,
          licenseExpiryDate: personalLicenseExpiry || null
        },
      });
      if (!personExistsInMaster) {
        showSuccess('Nueva persona guardada en la base de datos.');
      }
      const updatedData = await apiFetch('/master-data/personal', { token: authToken });
      setPersonalMasterData(updatedData.personal || []);
    } catch (err) {
      console.error('Error al guardar persona en la base maestra: ', err);
      showError(err.message || 'Error al guardar los datos de la persona. Intente de nuevo.');
      setLoading(false);
      return;
    } finally {
      setLoading(false);
    }

    const useExceptional = personalType === 'ingreso'
      && personalExceptionalReason.trim()
      && hasPermission(currentUser, 'access.exceptional_entry')
      && personalAccessStatus
      && !personalAccessStatus.authorized;

    setLoading(true);
    try {
      await addEntry('personal', {
        movementType: personalType,
        name: personalName,
        idNumber: personalId,
        company: personalCompany,
        destination: personalDestination,
        eventTime: personalEventTime,
        entrySource: 'manual',
        allowAccessOverride: useExceptional || personalAllowOverride,
        exceptionalReason: useExceptional ? personalExceptionalReason.trim() : undefined
      });
      resetPersonalForm();
    } finally {
      setLoading(false);
    }
  };

  const busy = loading || entriesLoading;

  return (
    <div className="form-section">
      <form onSubmit={handlePersonalSubmit} className="space-y-4">
        <div className="section-heading">
          <h2 className="text-2xl font-semibold text-red-700">Registro de Personal</h2>
          <p className="text-sm text-gray-600">
            Carga manual para personas que no pasan por la guardia (monitoreo por cámaras).
            Quienes ingresan por molinete escanean su DNI en el acceso automático.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <label htmlFor="personalName" className="block text-sm font-medium text-gray-700 mb-1">Nombre completo</label>
            <input
              type="text"
              id="personalName"
              value={personalName}
              onChange={handlePersonalNameChange}
              className="input-field"
              placeholder="Ej: Juan Pérez"
              required
              list="personal-names"
            />
            <datalist id="personal-names">
              {personalMasterData.map((person, index) => (
                <option key={index} value={person.name} />
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor="personalId" className="block text-sm font-medium text-gray-700 mb-1">DNI / Legajo</label>
            <input
              type="text"
              id="personalId"
              value={personalId}
              onChange={(e) => handlePersonalIdChange(e.target.value)}
              className="input-field"
              placeholder="Ej: 12345678"
              required
            />
          </div>
          <div>
            <label htmlFor="personalCompany" className="block text-sm font-medium text-gray-700 mb-1">Empresa</label>
            <input type="text" id="personalCompany" value={personalCompany} onChange={(e) => setPersonalCompany(e.target.value)} className="input-field" placeholder="Ej: Empresa Contratista S.A." />
          </div>
          <div>
            <label htmlFor="personalDestination" className="block text-sm font-medium text-gray-700 mb-1">Área / Destino</label>
            <input type="text" id="personalDestination" value={personalDestination} onChange={(e) => setPersonalDestination(e.target.value)} className="input-field" placeholder="Ej: Producción, Oficinas" />
          </div>
          <div>
            <label htmlFor="personalArtExpiry" className="block text-sm font-medium text-gray-700 mb-1">Vencimiento ART (opcional)</label>
            <input
              type="date"
              id="personalArtExpiry"
              value={personalArtExpiry}
              onChange={(e) => setPersonalArtExpiry(e.target.value)}
              className="input-field"
            />
          </div>
          <div>
            <label htmlFor="personalLicenseExpiry" className="block text-sm font-medium text-gray-700 mb-1">Vencimiento licencia (opcional)</label>
            <input
              type="date"
              id="personalLicenseExpiry"
              value={personalLicenseExpiry}
              onChange={(e) => setPersonalLicenseExpiry(e.target.value)}
              className="input-field"
            />
          </div>
        </div>

        {personalAccessStatus && personalType === 'ingreso' && (
          <div className={`rounded-md border px-3 py-2 text-sm ${personalAccessStatus.authorized ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
            {personalAccessStatus.authorized
              ? `Autorizado: ${personalAccessStatus.authorizationType || 'ok'}${personalAccessStatus.personName ? ` — ${personalAccessStatus.personName}` : ''}`
              : `Sin autorización vigente${personalAccessStatus.denialReason ? ` (${personalAccessStatus.denialReason})` : ''}`}
          </div>
        )}

        {personalNominaProfile && (
          <EmployeeNominaCard employee={personalNominaProfile} />
        )}

        {personalType === 'ingreso'
          && personalAccessStatus
          && !personalAccessStatus.authorized
          && hasPermission(currentUser, 'access.exceptional_entry') && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
            <p className="text-sm font-medium text-amber-900">Ingreso excepcional — motivo obligatorio</p>
            <textarea
              className="input-field min-h-[72px]"
              placeholder="Describa por qué se autoriza el ingreso (obligatorio)"
              value={personalExceptionalReason}
              onChange={(e) => setPersonalExceptionalReason(e.target.value)}
              required
              rows={2}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !personalExceptionalReason.trim()}
              onClick={handleExceptionalPersonalSubmit}
            >
              Registrar ingreso excepcional
            </button>
          </div>
        )}

        {hasPermission(currentUser, 'access.manual_override') && personalType === 'ingreso' && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={personalAllowOverride}
              onChange={(e) => setPersonalAllowOverride(e.target.checked)}
            />
            Autorizar ingreso manual y activar relevador aunque no haya citación
          </label>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="personalEventTime" className="block text-sm font-medium text-gray-700 mb-1">Hora del evento</label>
            <input type="time" id="personalEventTime" value={personalEventTime} onChange={(e) => setPersonalEventTime(e.target.value)} className="input-field" required />
          </div>
          <div>
            <label htmlFor="personalType" className="block text-sm font-medium text-gray-700 mb-1">Tipo de movimiento</label>
            <select id="personalType" value={personalType} onChange={(e) => setPersonalType(e.target.value)} className="input-field bg-white">
              <option value="ingreso">Ingreso</option>
              <option value="egreso">Egreso</option>
            </select>
          </div>
        </div>

        <button type="submit" className="btn btn-primary w-full md:w-auto" disabled={busy}>
          <Save size={20} /> {busy ? 'Guardando...' : 'Registrar personal'}
        </button>
      </form>
    </div>
  );
}

export default PersonalPage;
