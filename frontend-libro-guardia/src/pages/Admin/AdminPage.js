import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Car, ClipboardList, PlusCircle, Save, Loader2, UserPlus, Settings, KeyRound, Truck, Edit, Trash2, XCircle, Upload, ToggleRight, ToggleLeft, ShieldCheck, QrCode, DoorOpen } from 'lucide-react';
import * as XLSX from 'xlsx';
import PendingButton from '../../components/PendingButton';
import FleetGpsVehicleTable, { formatFleetTime } from '../../components/FleetGpsVehicleTable';
import FleetGpsLiveMap from '../../components/FleetGpsLiveMap';
import { normalizeGatePolygonsForSave } from '../../utils/fleetGpsGeofence';
import DoorsAdminPanel from '../../components/DoorsAdminPanel';
import RolesAdminPanel from '../../components/RolesAdminPanel';
import { hasPermission, canManageTargetUser, PERMISSION_LABELS } from '../../utils/permissions';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { API_BASE_URL } from '../../services/api';
import { ADMIN_SECTION_META, AUTH_WEEKDAYS, AUTH_TYPE_LABELS, formatAuthSchedule } from './adminConstants';

/**
 * Panel de administración completo.
 * @param {{ adminSection: string, onSectionChange: (id: string) => void, onExit?: () => void, onAccessConfigSaved?: (cfg: object) => void }} props
 */
function AdminPage({ adminSection, onSectionChange, onExit, onAccessConfigSaved }) {
  void onExit;
  const { authToken, currentUser, systemRoles, setSystemRoles } = useAuth();
  const { showSuccess, showError, setError } = useToast();
  const activeTab = 'adminPanel';


  const [pendingAction, setPendingAction] = useState(null);
  const [adminSectionLoading, setAdminSectionLoading] = useState(false);
  const [, setLoading] = useState(false);
  const [vehicleMasterData, setVehicleMasterData] = useState([]);
  const [selectedVehiclesFile, setSelectedVehiclesFile] = useState(null);
  const [selectedCitacionesFile, setSelectedCitacionesFile] = useState(null);
  const [selectedNominaFile, setSelectedNominaFile] = useState(null);
  const [nominaData, setNominaData] = useState([]);
  const [, setAccessControlConfig] = useState({
    enabled: false,
    host: '192.168.1.100',
    port: 6722,
    bridgeUrl: '',
    bridgeSecret: '',
    relayChannel: 1,
    pulseMode: 'jog',
    pulseSeconds: 3,
    triggerOn: 'ingreso',
    requireCitacion: true,
    allowMasterData: true,
    allowManualOverride: false,
    denyMessage: 'Acceso denegado: no tiene autorización vigente',
    kioskResetSeconds: 4
  });
  const [fleetGpsConfig, setFleetGpsConfig] = useState({
    enabled: false,
    provider: 'ubika',
    apiUrl: 'https://ubika.rastreo.com.ar',
    apiKey: '',
    hasApiKey: false,
    guardiaLat: '',
    guardiaLng: '',
    geofenceMode: 'circle',
    gatePolygons: [],
    plantPolygon: null,
    gateRadiusMeters: 45,
    plantRadiusMeters: 400,
    alertRadiusMeters: 45,
    minSpeedKnots: 1,
    requireMotion: true,
    autoRegisterMovements: true,
    movementCooldownSeconds: 300,
    pollIntervalSeconds: 20,
    approachAlertEnabled: false,
    approachRadiusMeters: 400,
    approachRequireMotion: true,
    lastError: null,
    lastSyncAt: null
  });
  const [fleetGpsTestResult, setFleetGpsTestResult] = useState(null);
  const fleetGpsMapRef = useRef(null);

  const [citacionesBridgeConfig, setCitacionesBridgeConfig] = useState({
    enabled: false,
    bridgeSecret: '',
    watchFolderHint: 'C:\\usr',
    lastSyncAt: null,
    lastSyncFile: null,
    lastSyncCount: 0,
    lastSyncError: null
  });

  const [citaciones, setCitaciones] = useState([]);
  const [newCitacionName, setNewCitacionName] = useState('');
  const [newCitacionDni, setNewCitacionDni] = useState('');
  const [newCitacionCompany, setNewCitacionCompany] = useState('');
  const [newCitacionDestination, setNewCitacionDestination] = useState('');
  const [newCitacionDate, setNewCitacionDate] = useState(new Date().toISOString().slice(0, 10));
  const [citacionesViewDate, setCitacionesViewDate] = useState(new Date().toISOString().slice(0, 10));
  const [citacionesViewMode, setCitacionesViewMode] = useState('planned');
  const [citacionesRangeFrom, setCitacionesRangeFrom] = useState(new Date().toISOString().slice(0, 10));
  const [citacionesRangeTo, setCitacionesRangeTo] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  });
  const [citacionesSearch, setCitacionesSearch] = useState('');
  const [citacionesFilterDate, setCitacionesFilterDate] = useState('');
  const [citacionesFilterFile, setCitacionesFilterFile] = useState('');
  const [citacionesImports, setCitacionesImports] = useState([]);
  const [plannedDates, setPlannedDates] = useState([]);
  const [newAuthType, setNewAuthType] = useState('citacion');
  const [newAuthStartDate, setNewAuthStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [newAuthEndDate, setNewAuthEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [newCitacionLegajo, setNewCitacionLegajo] = useState('');
  const [newAuthDaysOfWeek, setNewAuthDaysOfWeek] = useState(['Lu', 'Ma', 'Mi', 'Ju', 'Vi']);
  const [newAuthTimeFrom, setNewAuthTimeFrom] = useState('');
  const [newAuthTimeTo, setNewAuthTimeTo] = useState('');
  const [newAuthNotes, setNewAuthNotes] = useState('');
  const [newAuthPersonTipo, setNewAuthPersonTipo] = useState('empleado');
  const [newVehiclePlate, setNewVehiclePlate] = useState('');
  const [newVehicleBrand, setNewVehicleBrand] = useState('');
  const [newVehicleCompany, setNewVehicleCompany] = useState('');
  const [newVehicleDriver, setNewVehicleDriver] = useState('');
  const [rolePermissions, setRolePermissions] = useState({});
  const [permissionKeys, setPermissionKeys] = useState([]);
  const [editingUserPermissions, setEditingUserPermissions] = useState([]);
  const [, setMovilesList] = useState([]);
  const [, setDriversList] = useState([]);
  const [users, setUsers] = useState([]);
  const [newUsername, setNewUsername] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState('guardia');
  const [editingUser, setEditingUser] = useState(null);
  const [editedUsername, setEditedUsername] = useState('');
  const [editedUserRole, setEditedUserRole] = useState('');
  const [editedUserPassword, setEditedUserPassword] = useState('');
  const [editedUserActive, setEditedUserActive] = useState(true);
  const [selectedMobilesFile, setSelectedMobilesFile] = useState(null);
  const [selectedDriversFile, setSelectedDriversFile] = useState(null);
  const [, setPersonalMasterData] = useState([]);
  const actionLockRef = useRef(false);

  const runAction = useCallback(async (actionId, asyncFn) => {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setPendingAction(actionId);
    try {
      await asyncFn();
    } finally {
      actionLockRef.current = false;
      setPendingAction(null);
    }
  }, []);

  const setAdminSection = onSectionChange;

  // Efecto para cargar usuarios en el panel de administración
  useEffect(() => {
    const fetchUsers = async () => {
      if (!currentUser || !hasPermission(currentUser, 'users.view')) {
        setUsers([]);
        return;
      }
      try {
        setLoading(true);
        const response = await fetch(`${API_BASE_URL}/admin/users`, {
          headers: {
            'Authorization': `Bearer ${authToken}`
          }
        });
        if (!response.ok) {
          throw new Error('Error al cargar usuarios');
        }
        const data = await response.json();
        setUsers(data.users);
        setError(null);
      } catch (err) {
        console.error("Error al obtener usuarios:", err);
        if (err instanceof TypeError && err.message === 'Failed to fetch') {
          setError("No se pudo conectar con el servidor para cargar la lista de usuarios. Asegúrese de que el backend esté funcionando.");
        } else {
          setError(err.message || "Error al cargar la lista de usuarios. Asegúrese de tener permisos de administrador.");
        }
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, [currentUser, authToken]);
  useEffect(() => {
    const fetchVehicleMasterData = async () => {
      if (!currentUser || !hasPermission(currentUser, 'master.vehicles.read')) {
        setVehicleMasterData([]);
        return;
      }
      try {
        const response = await fetch(`${API_BASE_URL}/master-data/vehicles`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (response.ok) {
          const data = await response.json();
          setVehicleMasterData(data.vehicles || []);
        }
      } catch (err) {
        console.error('Error al cargar vehículos autorizados:', err);
      }
    };
    fetchVehicleMasterData();
  }, [currentUser, authToken]);
  useEffect(() => {
    const fetchCitaciones = async () => {
      if (!currentUser || !hasPermission(currentUser, 'master.citaciones.read')) {
        setCitaciones([]);
        return;
      }
      setAdminSectionLoading(true);
      try {
        let authUrl = `${API_BASE_URL}/admin/authorizations?`;
        if (citacionesViewMode === 'day') {
          authUrl += `date=${citacionesViewDate}`;
        } else if (citacionesViewMode === 'range') {
          authUrl += `from=${citacionesRangeFrom}&to=${citacionesRangeTo}`;
        } else {
          authUrl += `planned=true&date=${citacionesRangeFrom}`;
        }

        const response = await fetch(authUrl, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (response.ok) {
          const data = await response.json();
          setCitaciones(data.authorizations || []);
          setPlannedDates(data.plannedDates || []);
        }

        const importsRes = await fetch(`${API_BASE_URL}/admin/citaciones-imports?limit=100`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (importsRes.ok) {
          const importsData = await importsRes.json();
          setCitacionesImports(importsData.imports || []);
        }
      } catch (err) {
        console.error('Error al cargar citaciones:', err);
      } finally {
        setAdminSectionLoading(false);
      }
    };
    if (activeTab === 'adminPanel' && adminSection === 'citaciones') {
      fetchCitaciones();
      const fetchCitacionesBridge = async () => {
        if (!hasPermission(currentUser, 'master.citaciones.write')) return;
        try {
          const response = await fetch(`${API_BASE_URL}/admin/citaciones-bridge`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
          });
          if (response.ok) {
            const data = await response.json();
            setCitacionesBridgeConfig((prev) => ({ ...prev, ...(data.config || {}) }));
          }
        } catch (err) {
          console.error('Error al cargar puente de citaciones:', err);
        }
      };
      fetchCitacionesBridge();
    }
  }, [currentUser, authToken, activeTab, adminSection, citacionesViewDate, citacionesViewMode, citacionesRangeFrom, citacionesRangeTo]);

  useEffect(() => {
    const fetchRolePermissions = async () => {
      if (!currentUser || !hasPermission(currentUser, 'settings.permissions')) return;
      setAdminSectionLoading(true);
      try {
        const response = await fetch(`${API_BASE_URL}/admin/roles`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (response.ok) {
          const data = await response.json();
          const rolesMap = {};
          (data.roles || []).forEach((role) => {
            rolesMap[role.id] = role.permissions || [];
          });
          setRolePermissions(rolesMap);
          setSystemRoles(data.roles || []);
          setPermissionKeys(data.permissionKeys || []);
        }
      } catch (err) {
        console.error('Error al cargar permisos por rol:', err);
      } finally {
        setAdminSectionLoading(false);
      }
    };
    if (activeTab === 'adminPanel' && adminSection === 'permissions') {
      fetchRolePermissions();
    }
  }, [currentUser, authToken, activeTab, adminSection]);

  useEffect(() => {
    const fetchNomina = async () => {
      if (!currentUser || !hasPermission(currentUser, 'master.nomina.read')) return;
      setAdminSectionLoading(true);
      try {
        const response = await fetch(`${API_BASE_URL}/admin/nomina`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (response.ok) {
          const data = await response.json();
          setNominaData(data.personal || []);
        }
      } catch (err) {
        console.error('Error al cargar nómina:', err);
      } finally {
        setAdminSectionLoading(false);
      }
    };
    if (activeTab === 'adminPanel' && adminSection === 'nomina') {
      fetchNomina();
    }
  }, [currentUser, authToken, activeTab, adminSection]);

  useEffect(() => {
    const fetchKioskSettings = async () => {
      if (!currentUser || !hasPermission(currentUser, 'access.kiosk')) return;
      try {
        const response = await fetch(`${API_BASE_URL}/admin/access-control`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (response.ok) {
          const data = await response.json();
          setAccessControlConfig((prev) => { const next = { ...prev, ...(data.config || {}) }; onAccessConfigSaved?.(next); return next; });
        }
      } catch (err) {
        console.error('Error al cargar ajustes del molinete:', err);
      }
    };
    if (currentUser) fetchKioskSettings();
  }, [currentUser, authToken]);

  useEffect(() => {
    const fetchFleetGps = async () => {
      if (!currentUser || !hasPermission(currentUser, 'access.control')) return;
      setAdminSectionLoading(true);
      try {
        const fleetResponse = await fetch(`${API_BASE_URL}/admin/fleet-gps`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (fleetResponse.ok) {
          const data = await fleetResponse.json();
          const cfg = data.config || {};
          setFleetGpsConfig((prev) => ({
            ...prev,
            ...cfg,
            geofenceMode: cfg.geofenceMode || prev.geofenceMode || 'circle',
            gatePolygons: normalizeGatePolygonsForSave(cfg.gatePolygons || prev.gatePolygons || []),
            plantPolygon: cfg.plantPolygon ?? prev.plantPolygon ?? null,
            guardiaLat: cfg.guardiaLat ?? '',
            guardiaLng: cfg.guardiaLng ?? '',
            apiKey: cfg.hasApiKey ? '********' : ''
          }));
        }
      } catch (err) {
        console.error('Error al cargar GPS flota:', err);
      } finally {
        setAdminSectionLoading(false);
      }
    };
    if (activeTab === 'adminPanel' && adminSection === 'access') {
      fetchFleetGps();
    }
  }, [currentUser, authToken, activeTab, adminSection]);
  const handleCreateCitacion = async (e) => {
    e.preventDefault();
    if (!newCitacionName.trim()) {
      showError('El nombre es obligatorio');
      return;
    }
    if (!newCitacionDni.trim() && !newCitacionLegajo.trim()) {
      showError('Indique DNI o legajo');
      return;
    }

    await runAction('createCitacion', async () => {
      try {
        const authType = newAuthType === 'visit' ? 'visita' : newAuthType;
        const payload = {
          type: authType,
          name: newCitacionName.trim(),
          idNumber: newCitacionDni.trim(),
          legajo: newCitacionLegajo.trim(),
          company: newCitacionCompany.trim(),
          destination: newCitacionDestination.trim(),
          personTipo: newAuthPersonTipo,
          notes: newAuthNotes.trim(),
          startDate: authType === 'citacion'
            ? newCitacionDate
            : newAuthStartDate,
          endDate: authType === 'permanent'
            ? null
            : authType === 'citacion'
              ? newCitacionDate
              : newAuthEndDate
        };

        if (authType === 'permanent') {
          payload.daysOfWeek = newAuthDaysOfWeek.length ? newAuthDaysOfWeek : null;
          if (newAuthTimeFrom && newAuthTimeTo) {
            payload.timeWindow = { from: newAuthTimeFrom, to: newAuthTimeTo };
          }
        }

        const response = await fetch(`${API_BASE_URL}/admin/authorizations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Error al crear autorización');
        setNewCitacionName('');
        setNewCitacionDni('');
        setNewCitacionLegajo('');
        setNewCitacionCompany('');
        setNewCitacionDestination('');
        setNewAuthNotes('');
        showSuccess('Autorización cargada correctamente.');
        setCitaciones((prev) => [...prev, data.authorization]);
      } catch (err) {
        showError(err.message || 'Error al crear autorización');
      }
    });
  };

  const toggleAuthDay = (code) => {
    setNewAuthDaysOfWeek((prev) =>
      prev.includes(code) ? prev.filter((day) => day !== code) : [...prev, code]
    );
  };

  const handleDeleteCitacion = async (id) => {
    if (!window.confirm('¿Desactivar esta autorización?')) return;
    try {
      const response = await fetch(`${API_BASE_URL}/admin/authorizations/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Error al desactivar autorización');
      setCitaciones((prev) => prev.filter((item) => item.id !== id));
      showSuccess('Autorización desactivada.');
    } catch (err) {
      showError(err.message || 'Error al desactivar autorización');
    }
  };

  const handleSavePreloadedVehicle = async (e) => {
    e.preventDefault();
    await runAction('saveVehicle', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/master-data/vehicles`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({
            plate: newVehiclePlate,
            brand: newVehicleBrand,
            company: newVehicleCompany,
            driver: newVehicleDriver,
            authorized: true
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Error al precargar vehículo');
        setNewVehiclePlate('');
        setNewVehicleBrand('');
        setNewVehicleCompany('');
        setNewVehicleDriver('');
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
    if (!window.confirm('¿Eliminar este vehículo de la base autorizada?')) return;
    try {
      const response = await fetch(`${API_BASE_URL}/master-data/vehicles/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Error al eliminar vehículo');
      setVehicleMasterData((prev) => prev.filter((item) => item.id !== id));
      showSuccess('Vehículo eliminado de la base autorizada.');
    } catch (err) {
      showError(err.message || 'Error al eliminar vehículo');
    }
  };

  const toggleRolePermission = (role, permission) => {
    setRolePermissions((prev) => {
      const current = prev[role] || [];
      const exists = current.includes(permission);
      const updated = exists ? current.filter((item) => item !== permission) : [...current, permission];
      return { ...prev, [role]: updated };
    });
  };

  const handleSaveRolePermissions = async () => {
    await runAction('saveRolePermissions', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/admin/permissions/roles`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({ roles: rolePermissions })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Error al guardar permisos');
        showSuccess('Permisos por rol actualizados.');
      } catch (err) {
        showError(err.message || 'Error al guardar permisos');
      }
    });
  };

  const handleSaveUserPermissions = async () => {
    if (!editingUser) return;
    await runAction('saveUserPermissions', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/admin/users/${editingUser.id}/permissions`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({ permissions: editingUserPermissions })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Error al guardar permisos del usuario');
        showSuccess('Permisos personalizados guardados.');
        setUsers((prev) => prev.map((user) => (user.id === data.user.id ? data.user : user)));
      } catch (err) {
        showError(err.message || 'Error al guardar permisos del usuario');
      }
    });
  };

  const handleSaveFleetGps = async (e) => {
    e.preventDefault();
    await runAction('saveFleetGps', async () => {
      try {
        const configToSave = {
          ...fleetGpsConfig,
          gatePolygons: normalizeGatePolygonsForSave(fleetGpsConfig.gatePolygons || [])
        };

        const saveBody = {
          enabled: configToSave.enabled,
          provider: 'ubika',
          apiUrl: configToSave.apiUrl,
          apiKey: configToSave.apiKey,
          guardiaLat: configToSave.guardiaLat === '' ? null : Number(configToSave.guardiaLat),
          guardiaLng: configToSave.guardiaLng === '' ? null : Number(configToSave.guardiaLng),
          gateRadiusMeters: Number(configToSave.gateRadiusMeters) || 45,
          plantRadiusMeters: Number(configToSave.plantRadiusMeters) || 400,
          alertRadiusMeters: Number(configToSave.gateRadiusMeters) || 45,
          minSpeedKnots: Number(configToSave.minSpeedKnots) || 0,
          requireMotion: configToSave.requireMotion !== false,
          autoRegisterMovements: configToSave.autoRegisterMovements !== false,
          movementCooldownSeconds: Number(configToSave.movementCooldownSeconds) || 300,
          pollIntervalSeconds: Number(configToSave.pollIntervalSeconds) || 20,
          approachAlertEnabled: configToSave.approachAlertEnabled === true,
          approachRadiusMeters: Number(configToSave.approachRadiusMeters) || 400,
          approachRequireMotion: configToSave.approachRequireMotion !== false
        };

        const response = await fetch(`${API_BASE_URL}/admin/fleet-gps`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`
          },
          body: JSON.stringify(saveBody)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Error al guardar GPS UBIKA');
        const cfg = data.config || {};
        setFleetGpsConfig((prev) => ({
          ...prev,
          ...cfg,
          geofenceMode: cfg.geofenceMode || configToSave.geofenceMode || 'circle',
          gatePolygons: normalizeGatePolygonsForSave(cfg.gatePolygons || configToSave.gatePolygons || []),
          plantPolygon: cfg.plantPolygon ?? configToSave.plantPolygon ?? prev.plantPolygon ?? null,
          guardiaLat: cfg.guardiaLat ?? '',
          guardiaLng: cfg.guardiaLng ?? '',
          apiKey: cfg.hasApiKey ? '********' : ''
        }));
        showSuccess('Configuración GPS UBIKA guardada.');
      } catch (err) {
        showError(err.message || 'Error al guardar GPS UBIKA');
      }
    });
  };

  const handleTestFleetGps = async () => {
    await runAction('testFleetGps', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/admin/fleet-gps/test`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || data.error || 'Error al probar UBIKA');
        setFleetGpsTestResult(data);
        if (data.error) {
          showError(data.error);
        } else {
          showSuccess(data.message || 'Conexión UBIKA OK');
        }
      } catch (err) {
        setFleetGpsTestResult(null);
        showError(err.message || 'Error al probar GPS UBIKA');
      }
    });
  };

  const handleSaveCitacionesBridge = async (e) => {
    e.preventDefault();
    await runAction('saveCitacionesBridge', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/admin/citaciones-bridge`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({
            enabled: citacionesBridgeConfig.enabled,
            bridgeSecret: citacionesBridgeConfig.bridgeSecret,
            watchFolderHint: citacionesBridgeConfig.watchFolderHint
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Error al guardar puente de citaciones');
        setCitacionesBridgeConfig((prev) => ({ ...prev, ...(data.config || {}) }));
        showSuccess('Puente de carpeta de citaciones guardado.');
      } catch (err) {
        showError(err.message || 'Error al guardar puente de citaciones');
      }
    });
  };

  const handleGenerateCitacionesBridgeSecret = () => {
    const bytes = new Uint8Array(18);
    window.crypto.getRandomValues(bytes);
    const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    setCitacionesBridgeConfig((prev) => ({ ...prev, bridgeSecret: secret }));
  };

  const handleRelinkCitacionesNomina = async () => {
    await runAction('relinkCitacionesNomina', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/admin/citaciones/relink-nomina`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`
          },
          body: JSON.stringify({ date: citacionesFilterDate || newCitacionDate })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Error al vincular citaciones');
        showSuccess(data.message || `${data.linked || 0} citación(es) vinculada(s)`);
      } catch (err) {
        showError(err.message || 'No se pudo vincular citaciones con nómina');
      }
    });
  };

  const handleReprocessCitacionesImport = async (importId) => {
    await runAction(`reprocess-import-${importId}`, async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/admin/citaciones-imports/${importId}/reprocess`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`
          },
          body: JSON.stringify({ force: true })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Error al reprocesar importación');
        showSuccess(data.message || 'Importación reprocesada');
        const importsRes = await fetch(`${API_BASE_URL}/admin/citaciones-imports?limit=100`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (importsRes.ok) {
          const importsData = await importsRes.json();
          setCitacionesImports(importsData.imports || []);
        }
      } catch (err) {
        showError(err.message || 'No se pudo reprocesar la importación');
      }
    });
  };

  const handleDownloadImportJson = async (importId, sourceFile) => {
    try {
      const response = await fetch(`${API_BASE_URL}/admin/citaciones-imports/${importId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Error al descargar importación');
      const blob = new Blob([JSON.stringify(data.import, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sourceFile || 'citaciones'}-${importId}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showError(err.message || 'No se pudo descargar el JSON');
    }
  };

  const filteredCitaciones = citaciones.filter((item) => {
    if (citacionesFilterDate && item.startDate !== citacionesFilterDate) return false;
    if (citacionesFilterFile && item.importSource !== citacionesFilterFile) return false;
    if (citacionesSearch.trim()) {
      const q = citacionesSearch.trim().toLowerCase();
      const nameMatch = (item.name || '').toLowerCase().includes(q);
      const legajoMatch = String(item.legajo || '').includes(q);
      if (!nameMatch && !legajoMatch) return false;
    }
    return true;
  });

  const toggleEditingUserPermission = (permission) => {
    setEditingUserPermissions((prev) =>
      prev.includes(permission) ? prev.filter((item) => item !== permission) : [...prev, permission]
    );
  };
  // Funciones del panel de administración
  const handleCreateUser = async (e) => {
    e.preventDefault();
    setError(null);
    await runAction('createUser', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/admin/users`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({ username: newUsername, password: newUserPassword, role: newUserRole })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || 'Error al crear usuario');
        }

        setNewUsername('');
        setNewUserPassword('');
        setNewUserRole('guardia');
        showSuccess('Usuario creado exitosamente.');
        const usersResponse = await fetch(`${API_BASE_URL}/admin/users`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const usersData = await usersResponse.json();
        setUsers(usersData.users);
      } catch (createError) {
        console.error('Error al crear usuario:', createError);
        if (createError instanceof TypeError && createError.message === 'Failed to fetch') {
          setError('No se pudo conectar con el servidor para crear el usuario. Asegúrese de que el backend esté funcionando.');
        } else {
          setError(createError.message || 'Error al crear usuario.');
        }
      }
    });
  };

  const handleEditUser = (user) => {
    setEditingUser(user);
    setEditedUsername(user.username);
    setEditedUserRole(user.role);
    setEditedUserPassword('');
    setEditedUserActive(user.active);
    setEditingUserPermissions(user.customPermissions || []);
  };

  const handleSaveUserEdit = async (e) => {
    e.preventDefault();
    setError(null);
    await runAction('saveUserEdit', async () => {
      try {
        const updateData = { role: editedUserRole, active: editedUserActive };
        if (editedUserPassword) {
          updateData.password = editedUserPassword;
        }

        const response = await fetch(`${API_BASE_URL}/admin/users/${editingUser.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify(updateData)
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || 'Error al actualizar usuario');
        }

        setEditingUser(null);
        showSuccess('Usuario actualizado exitosamente.');
        const usersResponse = await fetch(`${API_BASE_URL}/admin/users`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const usersData = await usersResponse.json();
        setUsers(usersData.users);
      } catch (saveError) {
        console.error('Error al actualizar usuario:', saveError);
        if (saveError instanceof TypeError && saveError.message === 'Failed to fetch') {
          setError('No se pudo conectar con el servidor para actualizar el usuario. Asegúrese de que el backend esté funcionando.');
        } else {
          setError(saveError.message || 'Error al actualizar usuario.');
        }
      }
    });
  };

  const handleDeleteUser = async (userId) => {
    // Reemplazado window.confirm por un modal o mensaje en la UI si fuera una app de producción
    if (!window.confirm('¿Estás seguro de que quieres eliminar este usuario? Esta acción es irreversible.')) {
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Error al eliminar usuario');
      }

      showSuccess("Usuario eliminado exitosamente.");
      // Refrescar la lista de usuarios
      const usersResponse = await fetch(`${API_BASE_URL}/admin/users`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const usersData = await usersResponse.json();
      setUsers(usersData.users);

    } catch (error) {
      console.error("Error al eliminar usuario:", error);
      if (error instanceof TypeError && error.message === 'Failed to fetch') {
        setError("No se pudo conectar con el servidor para eliminar el usuario. Asegúrese de que el backend esté funcionando.");
      } else {
        setError(error.message || "Error al eliminar usuario.");
      }
    } finally {
      setLoading(false);
    }
  };

  // Manejadores de archivo para carga de flota
  const handleFileChange = (e, type) => {
    if (type === 'mobiles') {
      setSelectedMobilesFile(e.target.files[0]);
    } else if (type === 'drivers') {
      setSelectedDriversFile(e.target.files[0]);
    } else if (type === 'vehicles') {
      setSelectedVehiclesFile(e.target.files[0]);
    } else if (type === 'citaciones') {
      setSelectedCitacionesFile(e.target.files[0]);
    } else if (type === 'nomina') {
      setSelectedNominaFile(e.target.files[0]);
    }
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
        const response = await fetch(`${API_BASE_URL}/admin/nomina/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`
          },
          body: JSON.stringify({ data: parsedData })
        });
        const rawText = await response.text();
        let result;
        try {
          result = rawText ? JSON.parse(rawText) : {};
        } catch {
          throw new Error(response.status === 502
            ? 'El servidor tardó demasiado o rechazó la carga. Intente de nuevo en unos segundos.'
            : 'Respuesta inválida del servidor. Intente de nuevo.');
        }
        if (!response.ok) throw new Error(result.message || 'Error al importar nómina');
        if ((result.imported ?? 0) === 0 && (result.total ?? 0) > 0) {
          const sample = (result.errors || []).slice(0, 3).map((e) => `${e.name}: ${e.reason}`).join(' · ');
          setError(result.message || `Ningún empleado importado${sample ? ` (${sample})` : ''}`);
        } else {
          showSuccess(result.message || 'Nómina importada');
        }
        setSelectedNominaFile(null);
        const listRes = await fetch(`${API_BASE_URL}/admin/nomina`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (listRes.ok) {
          const listData = await listRes.json();
          setNominaData(listData.personal || []);
        }
        const personalRes = await fetch(`${API_BASE_URL}/master-data/personal`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (personalRes.ok) {
          const personalPayload = await personalRes.json();
          setPersonalMasterData(personalPayload.personal || []);
        }
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

  const handleUploadFleetData = async (type) => {
    let fileToUpload = null;
    let endpoint = '';
    let successMessage = '';
    let errorMessage = '';
    let parseRows = (json) => json.map((row) => ({ name: row.name }));

    if (type === 'mobiles') {
      fileToUpload = selectedMobilesFile;
      endpoint = '/admin/fleet/mobiles/upload';
      successMessage = 'Lista de móviles actualizada exitosamente.';
      errorMessage = 'Error al subir la lista de móviles.';
    } else if (type === 'drivers') {
      fileToUpload = selectedDriversFile;
      endpoint = '/admin/fleet/drivers/upload';
      successMessage = 'Lista de choferes actualizada exitosamente.';
      errorMessage = 'Error al subir la lista de choferes.';
    } else if (type === 'vehicles') {
      fileToUpload = selectedVehiclesFile;
      endpoint = '/admin/fleet/vehicles/upload';
      successMessage = 'Vehículos autorizados cargados exitosamente.';
      errorMessage = 'Error al subir vehículos autorizados.';
      parseRows = (json) => json.map((row) => ({
        plate: row.plate || row.patente || row.Patente,
        brand: row.brand || row.marca || row.Marca,
        company: row.company || row.empresa || row.Empresa,
        driver: row.driver || row.conductor || row.Conductor,
        authorized: row.authorized !== false && row.autorizado !== false
      }));
    } else if (type === 'citaciones') {
      fileToUpload = selectedCitacionesFile;
      endpoint = '/admin/authorizations/upload';
      successMessage = 'Autorizaciones cargadas exitosamente.';
      errorMessage = 'Error al subir autorizaciones.';
      parseRows = (json) => json.map((row) => ({
        type: row.type || row.tipo || row.Tipo || 'citacion',
        name: row.name || row.nombre || row.Nombre,
        idNumber: row.idNumber || row.dni || row.DNI || row.documento,
        company: row.company || row.empresa || row.Empresa,
        destination: row.destination || row.destino || row.Destino || row.area,
        startDate: row.startDate || row.fecha_inicio || row.fecha || row.Fecha,
        endDate: row.endDate || row.fecha_fin || row.fecha_hasta || row.Fecha_fin
      }));
    }

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

        if (type === 'citaciones') {
          const response = await fetch(`${API_BASE_URL}/admin/citaciones/sync-upload`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`
            },
            body: JSON.stringify({
              data: json,
              sourceFile: fileToUpload.name,
              force: true
            })
          });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.message || errorMessage);
          }
          showSuccess(result.message || successMessage);
          const citacionesRes = await fetch(`${API_BASE_URL}/admin/authorizations?date=${newCitacionDate}`, {
            headers: { Authorization: `Bearer ${authToken}` }
          });
          if (citacionesRes.ok) {
            const citacionesData = await citacionesRes.json();
            setCitaciones(citacionesData.authorizations || []);
          }
          const importsRes = await fetch(`${API_BASE_URL}/admin/citaciones-imports?limit=100`, {
            headers: { Authorization: `Bearer ${authToken}` }
          });
          if (importsRes.ok) {
            const importsData = await importsRes.json();
            setCitacionesImports(importsData.imports || []);
          }
          setSelectedCitacionesFile(null);
          return;
        }

        const parsedData = parseRows(json);

        const response = await fetch(`${API_BASE_URL}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({ data: parsedData })
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.message || errorMessage);
        }

        showSuccess(successMessage);
        if (type === 'vehicles') {
          const vehiclesRes = await fetch(`${API_BASE_URL}/master-data/vehicles`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
          });
          if (vehiclesRes.ok) {
            const vehiclesData = await vehiclesRes.json();
            setVehicleMasterData(vehiclesData.vehicles || []);
          }
          setSelectedVehiclesFile(null);
        } else if (type === 'citaciones') {
          const citacionesRes = await fetch(`${API_BASE_URL}/admin/authorizations?date=${newCitacionDate}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
          });
          if (citacionesRes.ok) {
            const citacionesData = await citacionesRes.json();
            setCitaciones(citacionesData.authorizations || []);
          }
          setSelectedCitacionesFile(null);
        } else {
          const [mobilesRes, driversRes] = await Promise.all([
            fetch(`${API_BASE_URL}/fleet/mobiles`, { headers: { 'Authorization': `Bearer ${authToken}` } }),
            fetch(`${API_BASE_URL}/fleet/drivers`, { headers: { 'Authorization': `Bearer ${authToken}` } })
          ]);
          const mobilesData = await mobilesRes.json();
          const driversData = await driversRes.json();
          setMovilesList(mobilesData.mobiles.map(m => m.name));
          setDriversList(driversData.drivers.map(d => d.name));
          setSelectedMobilesFile(null);
          setSelectedDriversFile(null);
        }

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

  const adminNavItems = useMemo(() => {
    if (!currentUser) return [];
    const items = [];
    if (hasPermission(currentUser, 'users.view')) items.push({ id: 'users', label: 'Usuarios', icon: KeyRound });
    if (hasPermission(currentUser, 'roles.view') || hasPermission(currentUser, 'roles.manage')) {
      items.push({ id: 'roles', label: 'Roles', icon: ShieldCheck });
    }
    if (hasPermission(currentUser, 'access.doors.manage') || hasPermission(currentUser, 'access.control')) {
      items.push({ id: 'doors', label: 'Puertas y acceso', icon: DoorOpen });
    }
    if (hasPermission(currentUser, 'access.control')) items.push({ id: 'access', label: 'GPS flota', icon: ShieldCheck });
    if (hasPermission(currentUser, 'master.citaciones.write')) items.push({ id: 'citaciones', label: 'Autorizaciones', icon: QrCode });
    if (hasPermission(currentUser, 'master.nomina.write')) items.push({ id: 'nomina', label: 'Nómina', icon: ClipboardList });
    if (hasPermission(currentUser, 'master.vehicles.write')) items.push({ id: 'vehicles', label: 'Vehículos', icon: Car });
    if (hasPermission(currentUser, 'fleet.upload')) items.push({ id: 'fleet', label: 'Flota interna', icon: Truck });
    if (hasPermission(currentUser, 'settings.permissions')) items.push({ id: 'permissions', label: 'Permisos', icon: Settings });
    return items;
  }, [currentUser]);
  const assignableRoles = useMemo(() => {
    if (!currentUser) return [];
    return (systemRoles.length ? systemRoles : [
      { id: 'monitoreo', label: 'Monitoreo' },
      { id: 'guardia', label: 'Guardia' },
      { id: 'supervisor', label: 'Supervisor' },
      { id: 'admin', label: 'Administrador' }
    ]).filter((role) => canManageTargetUser(currentUser, { role: role.id }));
  }, [currentUser, systemRoles]);

  const permissionMatrixRoles = useMemo(() => {
    if (systemRoles.length) return systemRoles;
    return Object.keys(rolePermissions).map((id) => ({ id, label: id }));
  }, [systemRoles, rolePermissions]);
  const activeAdminMeta = ADMIN_SECTION_META[adminSection] || { title: 'Administración', description: '' };

  return (
    <>
                  <div className="admin-panel">
              <div className="admin-panel-top">
                <div>
                  <span className="admin-panel-badge"><Settings size={12} /> Administración</span>
                  <h2>Panel de control</h2>
                  <p>Configuración avanzada del Libro de Guardia — solo personal autorizado.</p>
                </div>
                {pendingAction && (
                  <div className="admin-action-indicator">
                    <Loader2 className="animate-spin" size={18} />
                    <span>Acción en curso…</span>
                  </div>
                )}
              </div>

              <div className="admin-panel-layout">
                <aside className="admin-sidebar" aria-label="Secciones de administración">
                  {adminNavItems.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      className={`admin-sidebar-btn${adminSection === id ? ' active' : ''}`}
                      onClick={() => setAdminSection(id)}
                    >
                      <Icon size={18} aria-hidden />
                      {label}
                    </button>
                  ))}
                </aside>

                <div className="admin-content">
                  <div className="admin-content-header">
                    <h3>{activeAdminMeta.title}</h3>
                    <p>{activeAdminMeta.description}</p>
                  </div>

                  {adminSectionLoading && (
                    <div className="admin-section-loading">
                      <Loader2 className="animate-spin" size={32} />
                      <span>Cargando sección…</span>
                    </div>
                  )}

              {adminSection === 'users' && hasPermission(currentUser, 'users.view') && (
                <>
                  {hasPermission(currentUser, 'users.create') && (
                    <div className="admin-sub-section">
                      <h3 className="text-xl font-medium text-gray-800 mb-3 flex items-center gap-2"><UserPlus size={20} /> Crear nuevo usuario</h3>
                      <form onSubmit={handleCreateUser} className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <input type="text" id="newUsername" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} className="input-field" placeholder="Usuario" required />
                        <input type="password" id="newUserPassword" value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} className="input-field" placeholder="Contraseña" required />
                        <select id="newUserRole" value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)} className="input-field bg-white">
                          {assignableRoles.map((role) => (
                            <option key={role.id} value={role.id}>{role.label}</option>
                          ))}
                        </select>
                        <PendingButton type="submit" actionId="createUser" pendingAction={pendingAction} className="btn btn-success md:col-span-3" pendingLabel="Creando usuario...">
                          <PlusCircle size={20} /> Crear usuario
                        </PendingButton>
                      </form>
                    </div>
                  )}

                  <div className="admin-sub-section">
                    <h3 className="text-xl font-medium text-gray-800 mb-3 flex items-center gap-2"><KeyRound size={20} /> Gestión de usuarios</h3>
                    {users.length === 0 ? (
                      <p className="text-gray-500 text-center py-4">No hay usuarios registrados.</p>
                    ) : (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                        {users.map((user) => (
                          <div key={user.id} className="user-list-item">
                            <div>
                              <p className="font-semibold text-gray-900">{user.username}</p>
                              <p className="text-sm text-gray-600">Rol: <span className="capitalize">{systemRoles.find((r) => r.id === user.role)?.label || user.role}</span> · {user.active ? 'Activo' : 'Inactivo'}</p>
                            </div>
                            <div className="flex items-center gap-2 mt-2 sm:mt-0">
                              {hasPermission(currentUser, 'users.edit') && canManageTargetUser(currentUser, user) && (
                                <button onClick={() => handleEditUser(user)} className="btn btn-secondary-small"><Edit size={16} /> Editar</button>
                              )}
                              {hasPermission(currentUser, 'users.delete') && user.id !== currentUser.id && canManageTargetUser(currentUser, user) && (
                                <button onClick={() => handleDeleteUser(user.id)} className="btn btn-danger-small"><Trash2 size={16} /> Eliminar</button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {adminSection === 'citaciones' && hasPermission(currentUser, 'master.citaciones.write') && (
                <div className="admin-sub-section">
                  <h3 className="text-xl font-medium text-gray-800 mb-3">Autorizaciones de acceso</h3>
                  <p className="text-sm text-gray-600 mb-4">
                    Tipos: <strong>Citación</strong> (un día), <strong>Visita</strong> (rango de fechas), <strong>Permanente</strong>.
                  </p>

                  <div className="admin-bridge-panel mb-6">
                    <h4 className="text-lg font-medium text-gray-800 mb-2">Importación automática desde carpeta (Transporte)</h4>
                    <p className="text-sm text-gray-600 mb-4">
                      La web no puede leer el disco C del encargado de transporte. Instale el puente local
                      <code className="mx-1">scripts/citaciones-folder-bridge.js</code>
                      en esa PC: vigila la carpeta donde guarda la planilla Excel y sincroniza los citados con el molinete.
                    </p>
                    <form onSubmit={handleSaveCitacionesBridge} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-4">
                      <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
                        <input
                          type="checkbox"
                          checked={citacionesBridgeConfig.enabled}
                          onChange={(e) => setCitacionesBridgeConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
                        />
                        Habilitar puente de carpeta de citaciones
                      </label>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Carpeta a vigilar (referencia)</label>
                        <input
                          type="text"
                          value={citacionesBridgeConfig.watchFolderHint || ''}
                          onChange={(e) => setCitacionesBridgeConfig((prev) => ({ ...prev, watchFolderHint: e.target.value }))}
                          className="input-field"
                          placeholder="C:\usr"
                        />
                        <p className="text-xs text-gray-500 mt-1">Debe coincidir con watchFolder en citaciones-bridge.config.json de la PC de transporte.</p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Secreto del puente</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={citacionesBridgeConfig.bridgeSecret || ''}
                            onChange={(e) => setCitacionesBridgeConfig((prev) => ({ ...prev, bridgeSecret: e.target.value }))}
                            className="input-field flex-1"
                            placeholder="Generar y copiar al config local"
                            autoComplete="off"
                          />
                          <button type="button" className="btn btn-secondary-small whitespace-nowrap" onClick={handleGenerateCitacionesBridgeSecret}>
                            Generar
                          </button>
                        </div>
                      </div>
                      <div className="flex items-end">
                        <PendingButton
                          type="submit"
                          actionId="saveCitacionesBridge"
                          pendingAction={pendingAction}
                          className="btn btn-primary w-full"
                          pendingLabel="Guardando..."
                        >
                          Guardar puente
                        </PendingButton>
                      </div>
                    </form>
                    <div className="flex flex-wrap gap-2 mb-4">
                      <PendingButton
                        type="button"
                        actionId="relinkCitacionesNomina"
                        pendingAction={pendingAction}
                        className="btn btn-secondary"
                        pendingLabel="Vinculando..."
                        onClick={handleRelinkCitacionesNomina}
                      >
                        Vincular citados con nómina (hoy)
                      </PendingButton>
                      <p className="text-xs text-gray-500 self-center">
                        No requiere la PC de logística: usa las citaciones ya importadas y la nómina actual.
                      </p>
                    </div>
                    <div className="text-sm text-gray-600 grid grid-cols-1 md:grid-cols-2 gap-2 mb-4">
                      <p><strong>Última sync:</strong> {citacionesBridgeConfig.lastSyncAt ? new Date(citacionesBridgeConfig.lastSyncAt).toLocaleString('es-AR') : '—'}</p>
                      <p><strong>Archivo:</strong> {citacionesBridgeConfig.lastSyncFile || '—'}</p>
                      <p><strong>Registros:</strong> {citacionesBridgeConfig.lastSyncCount ?? 0}</p>
                      <p className="md:col-span-2 text-xs text-gray-500">
                        Cada planilla se guarda en el servidor (no se pisa la anterior). Las citaciones quedan por día según la columna <code>diacitacioningreso</code>.
                      </p>
                      {citacionesBridgeConfig.lastSyncError && (
                        <p className="text-red-600"><strong>Último error:</strong> {citacionesBridgeConfig.lastSyncError}</p>
                      )}
                    </div>

                    {citacionesImports.length > 0 && (
                      <div className="mb-4">
                        <h5 className="text-md font-medium text-gray-800 mb-2">Planificaciones importadas ({citacionesImports.length})</h5>
                        <div className="scroll-panel-max overflow-x-auto border border-gray-200 rounded-md">
                          <table className="min-w-full text-sm">
                            <thead className="bg-gray-100">
                              <tr>
                                <th className="px-3 py-2 text-left text-xs uppercase">Importado</th>
                                <th className="px-3 py-2 text-left text-xs uppercase">Archivo</th>
                                <th className="px-3 py-2 text-left text-xs uppercase">Días citados</th>
                                <th className="px-3 py-2 text-left text-xs uppercase">Personas</th>
                                <th className="px-3 py-2 text-left text-xs uppercase">JSON</th>
                                <th className="px-3 py-2 text-left text-xs uppercase">Acciones</th>
                              </tr>
                            </thead>
                            <tbody>
                              {citacionesImports.map((batch) => (
                                <tr key={batch.id} className="border-t">
                                  <td className="px-3 py-2">{batch.importedAt ? new Date(batch.importedAt).toLocaleString('es-AR') : '—'}</td>
                                  <td className="px-3 py-2">{batch.sourceFile || '—'}</td>
                                  <td className="px-3 py-2">{(batch.citacionDates || []).join(', ') || '—'}</td>
                                  <td className="px-3 py-2">{batch.rowCount}</td>
                                  <td className="px-3 py-2">
                                    <button
                                      type="button"
                                      className="btn btn-secondary-small"
                                      onClick={() => handleDownloadImportJson(batch.id, batch.sourceFile)}
                                    >
                                      Descargar
                                    </button>
                                  </td>
                                  <td className="px-3 py-2">
                                    <PendingButton
                                      type="button"
                                      actionId={`reprocess-import-${batch.id}`}
                                      pendingAction={pendingAction}
                                      className="btn btn-secondary-small"
                                      pendingLabel="..."
                                      onClick={() => handleReprocessCitacionesImport(batch.id)}
                                    >
                                      Reprocesar
                                    </PendingButton>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md p-3">
                      <p className="font-medium mb-1">Instalación en la PC de transporte</p>
                      <ol className="list-decimal list-inside space-y-1">
                        <li>Ejecutar <code>install-citaciones-bridge.cmd</code> en la PC de transporte</li>
                        <li>Editar <code>citaciones-bridge.config.json</code> (carpeta C:\usr, apiBaseUrl, bridgeSecret)</li>
                        <li>Ejecutar <code>node citaciones-folder-bridge.js</code> o PM2 para dejarlo activo</li>
                        <li>Cada planilla nueva (.xlsx/.xls/.csv) se importa sola; el molinete autoriza al escanear DNI</li>
                      </ol>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <div>
                      <label htmlFor="uploadCitaciones" className="block text-sm font-medium text-gray-700 mb-1">Carga manual (XLSX/CSV)</label>
                      <p className="text-xs text-gray-500 mb-2">Planilla de transporte: per__cod, per__des, sector__des, diacitacioningreso. Mismo formato que el puente automático.</p>
                      <input type="file" id="uploadCitaciones" accept=".csv, .xlsx" onChange={(e) => handleFileChange(e, 'citaciones')} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
                      <PendingButton
                        type="button"
                        actionId="upload-citaciones"
                        pendingAction={pendingAction}
                        className="btn btn-secondary mt-2 w-full"
                        disabled={!selectedCitacionesFile}
                        pendingLabel="Subiendo archivo..."
                        onClick={() => handleUploadFleetData('citaciones')}
                      >
                        <Upload size={20} /> Cargar autorizaciones desde Excel
                      </PendingButton>
                    </div>
                  </div>
                  <form onSubmit={handleCreateCitacion} className="space-y-4 mb-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                      <select value={newAuthType} onChange={(e) => setNewAuthType(e.target.value)} className="input-field bg-white">
                        <option value="citacion">Citación (un día)</option>
                        <option value="visita">Visita (rango de fechas)</option>
                        <option value="temporal">Temporal (contratista / obra)</option>
                        <option value="permanent">Permanente (turno / acceso fijo)</option>
                      </select>
                      <select value={newAuthPersonTipo} onChange={(e) => setNewAuthPersonTipo(e.target.value)} className="input-field bg-white">
                        <option value="empleado">Empleado</option>
                        <option value="tercero">Tercerizado</option>
                        <option value="cliente">Cliente</option>
                        <option value="visita">Visita externa</option>
                      </select>
                      <input type="text" value={newCitacionName} onChange={(e) => setNewCitacionName(e.target.value)} className="input-field" placeholder="Apellido y nombre" required />
                      <input type="text" value={newCitacionLegajo} onChange={(e) => setNewCitacionLegajo(e.target.value)} className="input-field" placeholder="Legajo (si no hay DNI)" />
                      <input type="text" value={newCitacionDni} onChange={(e) => setNewCitacionDni(e.target.value)} className="input-field" placeholder="DNI (opcional si hay legajo)" />
                      <input type="text" value={newCitacionCompany} onChange={(e) => setNewCitacionCompany(e.target.value)} className="input-field" placeholder="Empresa" />
                      <input type="text" value={newCitacionDestination} onChange={(e) => setNewCitacionDestination(e.target.value)} className="input-field" placeholder="Destino / sector" />
                      {newAuthType === 'citacion' && (
                        <input type="date" value={newCitacionDate} onChange={(e) => setNewCitacionDate(e.target.value)} className="input-field" required />
                      )}
                      {(newAuthType === 'visita' || newAuthType === 'temporal') && (
                        <>
                          <input type="date" value={newAuthStartDate} onChange={(e) => setNewAuthStartDate(e.target.value)} className="input-field" required title="Desde" />
                          <input type="date" value={newAuthEndDate} onChange={(e) => setNewAuthEndDate(e.target.value)} className="input-field" required title="Hasta" />
                        </>
                      )}
                      {newAuthType === 'permanent' && (
                        <>
                          <input type="date" value={newAuthStartDate} onChange={(e) => setNewAuthStartDate(e.target.value)} className="input-field" title="Vigencia desde (opcional)" />
                          <input type="time" value={newAuthTimeFrom} onChange={(e) => setNewAuthTimeFrom(e.target.value)} className="input-field" title="Horario desde" />
                          <input type="time" value={newAuthTimeTo} onChange={(e) => setNewAuthTimeTo(e.target.value)} className="input-field" title="Horario hasta" />
                        </>
                      )}
                      <input type="text" value={newAuthNotes} onChange={(e) => setNewAuthNotes(e.target.value)} className="input-field xl:col-span-2" placeholder="Observaciones (opcional)" />
                    </div>
                    {newAuthType === 'permanent' && (
                      <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                        <p className="text-sm font-medium text-gray-700 mb-2">Días habilitados (vacío = todos los días)</p>
                        <div className="flex flex-wrap gap-2">
                          {AUTH_WEEKDAYS.map(({ code, label }) => (
                            <label key={code} className="inline-flex items-center gap-1 text-sm bg-white border rounded px-2 py-1">
                              <input
                                type="checkbox"
                                checked={newAuthDaysOfWeek.includes(code)}
                                onChange={() => toggleAuthDay(code)}
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                        <p className="text-xs text-gray-500 mt-2">Ej. Tesorería: Lun–Vie 08:00–17:00. Sistemas: dejar días vacíos y sin horario.</p>
                      </div>
                    )}
                    <PendingButton type="submit" actionId="createCitacion" pendingAction={pendingAction} className="btn btn-primary" pendingLabel="Agregando...">
                      <PlusCircle size={18} /> Agregar autorización manual
                    </PendingButton>
                  </form>
                  <div className="flex flex-col gap-3 mb-3">
                    <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3">
                      <div>
                        <h4 className="text-lg font-medium text-gray-800">Listado de autorizados</h4>
                        <p className="text-sm text-gray-600">
                          {citacionesViewMode === 'planned'
                            ? 'Todas las citaciones planificadas en el rango (ej. sábado, domingo, lunes y martes).'
                            : citacionesViewMode === 'range'
                              ? 'Citaciones entre dos fechas.'
                              : 'Citaciones de un solo día.'}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <select
                          value={citacionesViewMode}
                          onChange={(e) => setCitacionesViewMode(e.target.value)}
                          className="input-field bg-white"
                        >
                          <option value="planned">Próximos días planificados</option>
                          <option value="day">Un día</option>
                          <option value="range">Rango de fechas</option>
                        </select>
                        {citacionesViewMode === 'day' && (
                          <input
                            type="date"
                            value={citacionesViewDate}
                            onChange={(e) => setCitacionesViewDate(e.target.value)}
                            className="input-field"
                          />
                        )}
                        {citacionesViewMode !== 'day' && (
                          <>
                            <input
                              type="date"
                              value={citacionesRangeFrom}
                              onChange={(e) => setCitacionesRangeFrom(e.target.value)}
                              className="input-field"
                              title="Desde"
                            />
                            {citacionesViewMode === 'range' && (
                              <input
                                type="date"
                                value={citacionesRangeTo}
                                onChange={(e) => setCitacionesRangeTo(e.target.value)}
                                className="input-field"
                                title="Hasta"
                              />
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {plannedDates.length > 0 && (
                      <div className="flex flex-wrap gap-2 items-center">
                        <span className="text-sm text-gray-600">Días con citaciones:</span>
                        <button
                          type="button"
                          className={`btn btn-secondary-small ${!citacionesFilterDate ? 'opacity-100' : ''}`}
                          onClick={() => setCitacionesFilterDate('')}
                        >
                          Todos ({citaciones.length})
                        </button>
                        {plannedDates.map(({ date, count }) => (
                          <button
                            key={date}
                            type="button"
                            className={`btn btn-secondary-small ${citacionesFilterDate === date ? 'ring-2 ring-red-500' : ''}`}
                            onClick={() => setCitacionesFilterDate(citacionesFilterDate === date ? '' : date)}
                          >
                            {date.split('-').reverse().join('/')} ({count})
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <input
                        type="text"
                        value={citacionesSearch}
                        onChange={(e) => setCitacionesSearch(e.target.value)}
                        className="input-field"
                        placeholder="Buscar por nombre o legajo"
                      />
                      <select
                        value={citacionesFilterFile}
                        onChange={(e) => setCitacionesFilterFile(e.target.value)}
                        className="input-field bg-white"
                      >
                        <option value="">Todas las planillas</option>
                        {[...new Set(citacionesImports.map((b) => b.sourceFile).filter(Boolean))].map((file) => (
                          <option key={file} value={file}>{file}</option>
                        ))}
                      </select>
                      <p className="text-sm text-gray-600 self-center">
                        Mostrando {filteredCitaciones.length} de {citaciones.length}
                      </p>
                    </div>
                  </div>
                  {filteredCitaciones.length === 0 && (
                    <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3">
                      No hay autorizaciones con los filtros actuales.
                      {citacionesViewMode === 'planned'
                        ? ' Verificá que el encargado haya importado planillas para sábado, domingo, lunes, etc.'
                        : ' Probá otro rango o fecha.'}
                    </p>
                  )}
                  <div className="scroll-panel-max overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-100 sticky top-0">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs uppercase">Tipo</th>
                          <th className="px-4 py-2 text-left text-xs uppercase">Vigencia</th>
                          <th className="px-4 py-2 text-left text-xs uppercase">Nombre</th>
                          <th className="px-4 py-2 text-left text-xs uppercase">Legajo</th>
                          <th className="px-4 py-2 text-left text-xs uppercase">DNI</th>
                          <th className="px-4 py-2 text-left text-xs uppercase">Planilla</th>
                          <th className="px-4 py-2 text-left text-xs uppercase">Empresa</th>
                          <th className="px-4 py-2 text-left text-xs uppercase">Destino</th>
                          <th className="px-4 py-2 text-left text-xs uppercase">Acción</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredCitaciones.map((item) => (
                          <tr key={item.id} className="border-t">
                            <td className="px-4 py-2">
                              <span className={`auth-type-badge ${(item.type === 'visit' ? 'visita' : item.type) || 'citacion'}`}>
                                {AUTH_TYPE_LABELS[item.type] || item.type || 'citacion'}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-sm">{formatAuthSchedule(item)}</td>
                            <td className="px-4 py-2">{item.name}</td>
                            <td className="px-4 py-2">{item.legajo || '—'}</td>
                            <td className="px-4 py-2">{item.idNumber || '—'}</td>
                            <td className="px-4 py-2 text-xs">{item.importSource || '—'}</td>
                            <td className="px-4 py-2">{item.company}</td>
                            <td className="px-4 py-2">{item.destination}</td>
                            <td className="px-4 py-2">
                              <button type="button" className="btn btn-danger-small" onClick={() => handleDeleteCitacion(item.id)}><Trash2 size={14} /></button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {adminSection === 'doors' && (hasPermission(currentUser, 'access.doors.manage') || hasPermission(currentUser, 'access.control')) && (
                <DoorsAdminPanel
                  authToken={authToken}
                  pendingAction={pendingAction}
                  onPending={runAction}
                  onSuccess={showSuccess}
                  onError={showError}
                  onGlobalAccessSaved={(cfg) => { setAccessControlConfig((prev) => ({ ...prev, ...(cfg || {}) })); onAccessConfigSaved?.(cfg); }}
                />
              )}

              {adminSection === 'access' && hasPermission(currentUser, 'access.control') && (
                <div className="admin-sub-section">
                  <h3 className="text-xl font-medium text-gray-800 mb-3">GPS flota interna (UBIKA)</h3>
                    <p className="text-sm text-gray-600 mb-4">
                      Detecta tránsito en el portón (entrando/saliendo), no los móviles estacionados en planta.
                      Puede usar círculos rápidos o dibujar polígonos sobre cada portón en el mapa (recomendado si hay 2 accesos).
                    </p>
                    <form onSubmit={handleSaveFleetGps} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
                        <input
                          type="checkbox"
                          checked={Boolean(fleetGpsConfig.enabled)}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
                        />
                        Habilitar monitoreo GPS en panel del guardia
                      </label>
                      <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
                        <input
                          type="checkbox"
                          checked={fleetGpsConfig.autoRegisterMovements !== false}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, autoRegisterMovements: e.target.checked }))}
                        />
                        Registrar automáticamente ingresos/egresos en el libro de guardia
                      </label>
                      <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
                        <input
                          type="checkbox"
                          checked={fleetGpsConfig.requireMotion !== false}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, requireMotion: e.target.checked }))}
                        />
                        Solo contar móviles en movimiento (ignora estacionados)
                      </label>
                      <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
                        <input
                          type="checkbox"
                          checked={fleetGpsConfig.approachAlertEnabled === true}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, approachAlertEnabled: e.target.checked }))}
                        />
                        Alerta de vehículo acercándose a planta (avisa al guardia en el panel GPS). Compatible con polígonos de Portón Santiago y Portón Olmos.
                      </label>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Latitud guardia</label>
                        <input
                          type="number"
                          step="any"
                          value={fleetGpsConfig.guardiaLat}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, guardiaLat: e.target.value }))}
                          className="input-field"
                          placeholder="-31.420000"
                          required={fleetGpsConfig.enabled}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Longitud guardia</label>
                        <input
                          type="number"
                          step="any"
                          value={fleetGpsConfig.guardiaLng}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, guardiaLng: e.target.value }))}
                          className="input-field"
                          placeholder="-64.180000"
                          required={fleetGpsConfig.enabled}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Radio portón (metros)</label>
                        <input
                          type="number"
                          min="15"
                          max="120"
                          value={fleetGpsConfig.gateRadiusMeters ?? fleetGpsConfig.alertRadiusMeters ?? 45}
                          onChange={(e) => setFleetGpsConfig((prev) => ({
                            ...prev,
                            gateRadiusMeters: Number(e.target.value),
                            alertRadiusMeters: Number(e.target.value)
                          }))}
                          className="input-field"
                          disabled={fleetGpsConfig.geofenceMode === 'polygon'}
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          {fleetGpsConfig.geofenceMode === 'polygon'
                            ? 'En modo polígonos se usa el dibujo del mapa.'
                            : 'Zona de tránsito. Recomendado 35–50 m.'}
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Radio planta (metros)</label>
                        <input
                          type="number"
                          min="80"
                          max="2000"
                          value={fleetGpsConfig.plantRadiusMeters ?? 400}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, plantRadiusMeters: Number(e.target.value) }))}
                          className="input-field"
                        />
                        <p className="text-xs text-gray-500 mt-1">Respaldo si no dibuja polígono de planta.</p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Radio alerta llegada (metros)</label>
                        <input
                          type="number"
                          min="100"
                          max="3000"
                          value={fleetGpsConfig.approachRadiusMeters ?? 400}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, approachRadiusMeters: Number(e.target.value) }))}
                          className="input-field"
                          disabled={!fleetGpsConfig.approachAlertEnabled}
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Avisa cuando un móvil en movimiento entra en este radio y aún no está en planta/portón.
                          El ingreso/egreso se registra al cruzar el polígono del portón (Santiago u Olmos).
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Velocidad mínima (nudos)</label>
                        <input
                          type="number"
                          min="0"
                          max="20"
                          step="0.5"
                          value={fleetGpsConfig.minSpeedKnots ?? 1}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, minSpeedKnots: Number(e.target.value) }))}
                          className="input-field"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Espera entre registros (seg)</label>
                        <input
                          type="number"
                          min="60"
                          max="3600"
                          value={fleetGpsConfig.movementCooldownSeconds ?? 300}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, movementCooldownSeconds: Number(e.target.value) }))}
                          className="input-field"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Consulta cada (segundos)</label>
                        <input
                          type="number"
                          min="15"
                          max="120"
                          value={fleetGpsConfig.pollIntervalSeconds}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, pollIntervalSeconds: Number(e.target.value) }))}
                          className="input-field"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">URL API UBIKA</label>
                        <input
                          type="text"
                          value={fleetGpsConfig.apiUrl}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, apiUrl: e.target.value }))}
                          className="input-field"
                          placeholder="https://ubika.rastreo.com.ar"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Token API</label>
                        <input
                          type="password"
                          value={fleetGpsConfig.apiKey}
                          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, apiKey: e.target.value }))}
                          className="input-field"
                          placeholder={fleetGpsConfig.hasApiKey ? 'Token configurado' : 'Bearer token'}
                          autoComplete="off"
                        />
                      </div>
                      <div className="md:col-span-2 xl:col-span-3 flex flex-wrap gap-3">
                        <PendingButton type="submit" actionId="saveFleetGps" pendingAction={pendingAction} className="btn btn-primary" pendingLabel="Guardando...">
                          <Save size={18} /> Guardar GPS UBIKA
                        </PendingButton>
                        <PendingButton type="button" actionId="testFleetGps" pendingAction={pendingAction} className="btn btn-secondary" pendingLabel="Probando..." onClick={handleTestFleetGps}>
                          <ShieldCheck size={18} /> Probar conexión
                        </PendingButton>
                      </div>
                      {(fleetGpsConfig.lastError || fleetGpsConfig.lastSyncAt) && !fleetGpsTestResult && (
                        <div className="md:col-span-2 xl:col-span-3 text-sm text-gray-600">
                          {fleetGpsConfig.lastSyncAt && (
                            <p>Última sincronización: {formatFleetTime(fleetGpsConfig.lastSyncAt)}</p>
                          )}
                          {fleetGpsConfig.lastError && (
                            <p className="text-red-600">Último error: {fleetGpsConfig.lastError}</p>
                          )}
                        </div>
                      )}
                      {fleetGpsTestResult && (
                        <div className="md:col-span-2 xl:col-span-3 fleet-gps-admin-result">
                          <div className="fleet-gps-summary">
                            <div className="fleet-gps-summary__card">
                              <span className="fleet-gps-summary__label">Flota total</span>
                              <span className="fleet-gps-summary__value">{fleetGpsTestResult.vehicleCount ?? '—'}</span>
                            </div>
                            <div className={`fleet-gps-summary__card${(fleetGpsTestResult.transit || fleetGpsTestResult.alerts || []).length ? ' fleet-gps-summary__card--alert' : ''}`}>
                              <span className="fleet-gps-summary__label">En tránsito</span>
                              <span className="fleet-gps-summary__value">{(fleetGpsTestResult.transit || fleetGpsTestResult.alerts || []).length}</span>
                            </div>
                            <div className="fleet-gps-summary__card">
                              <span className="fleet-gps-summary__label">En planta quietos</span>
                              <span className="fleet-gps-summary__value">{(fleetGpsTestResult.inPlant || []).length}</span>
                            </div>
                            <div className="fleet-gps-summary__card fleet-gps-summary__card--wide">
                              <span className="fleet-gps-summary__label">Estado</span>
                              <span className="fleet-gps-summary__text">
                                {fleetGpsTestResult.error || fleetGpsTestResult.message}
                              </span>
                              <span className="fleet-gps-summary__meta">
                                Portón {fleetGpsTestResult.gateRadiusMeters || fleetGpsConfig.gateRadiusMeters || 45} m
                                {' · '}
                                Planta {fleetGpsTestResult.plantRadiusMeters || fleetGpsConfig.plantRadiusMeters || 400} m
                                {fleetGpsTestResult.config?.lastSyncAt
                                  ? ` · ${formatFleetTime(fleetGpsTestResult.config.lastSyncAt)}`
                                  : ''}
                              </span>
                            </div>
                          </div>

                          {(fleetGpsTestResult.transit || fleetGpsTestResult.alerts || []).length > 0 ? (
                            <>
                              <h4 className="fleet-gps-section-title">Tránsito en portón (entrando / saliendo)</h4>
                              <FleetGpsVehicleTable
                                vehicles={(fleetGpsTestResult.transit || fleetGpsTestResult.alerts).map((item) => ({
                                  ...item,
                                  name: `${item.directionLabel || item.direction || ''}: ${item.name}`
                                }))}
                                radiusMeters={Number(fleetGpsTestResult.gateRadiusMeters || fleetGpsConfig.gateRadiusMeters) || 45}
                              />
                            </>
                          ) : (
                            <>
                              <h4 className="fleet-gps-section-title">Más cercanos al portón (sin tránsito ahora)</h4>
                              <FleetGpsVehicleTable
                                vehicles={fleetGpsTestResult.nearest || []}
                                radiusMeters={Number(fleetGpsTestResult.gateRadiusMeters || fleetGpsConfig.gateRadiusMeters) || 45}
                                emptyMessage="No se obtuvieron posiciones de la flota"
                              />
                            </>
                          )}
                        </div>
                      )}
                    </form>

                  <FleetGpsLiveMap
                    ref={fleetGpsMapRef}
                    authToken={authToken}
                    previewConfig={fleetGpsConfig}
                    active={adminSection === 'access'}
                    editable
                    onGeofenceChange={(patch) => setFleetGpsConfig((prev) => ({ ...prev, ...patch }))}
                    onGeofenceSaved={() => showSuccess('Geocercas del mapa guardadas.')}
                    onGeofenceError={(message) => showError(message)}
                  />
                </div>
              )}

              {adminSection === 'nomina' && hasPermission(currentUser, 'master.nomina.write') && (
                <>
                  <div className="admin-sub-section">
                    <h3 className="text-xl font-medium text-gray-800 mb-3">Importar nómina de personal</h3>
                    <p className="text-sm text-gray-600 mb-4">
                      Cargue el Excel de nómina (columnas Usuario, DNI, Legajo, Rol, C. Costo, Turno, Con citacion, Tipo de autorización).
                      Actualiza la base de empleados, turnos y autorizaciones permanentes.
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="uploadNomina" className="block text-sm font-medium text-gray-700 mb-1">Archivo XLSX</label>
                        <input
                          type="file"
                          id="uploadNomina"
                          accept=".xlsx,.xls"
                          onChange={(e) => handleFileChange(e, 'nomina')}
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
                  </div>
                  <div className="admin-sub-section">
                    <h3 className="text-xl font-medium text-gray-800 mb-3">
                      Empleados en nómina ({nominaData.length})
                    </h3>
                    {adminSectionLoading ? (
                      <p className="text-sm text-gray-500">Cargando...</p>
                    ) : nominaData.length === 0 ? (
                      <p className="text-sm text-gray-500">Sin empleados cargados. Importe la planilla de nómina.</p>
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
                  </div>
                </>
              )}

              {adminSection === 'vehicles' && hasPermission(currentUser, 'master.vehicles.write') && (
                <>
                  <div className="admin-sub-section">
                    <h3 className="text-xl font-medium text-gray-800 mb-3">Precarga de vehículos autorizados</h3>
                    <form onSubmit={handleSavePreloadedVehicle} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
                      <input type="text" value={newVehiclePlate} onChange={(e) => setNewVehiclePlate(e.target.value)} className="input-field" placeholder="Patente" required />
                      <input type="text" value={newVehicleBrand} onChange={(e) => setNewVehicleBrand(e.target.value)} className="input-field" placeholder="Marca / modelo" />
                      <input type="text" value={newVehicleCompany} onChange={(e) => setNewVehicleCompany(e.target.value)} className="input-field" placeholder="Empresa" />
                      <input type="text" value={newVehicleDriver} onChange={(e) => setNewVehicleDriver(e.target.value)} className="input-field" placeholder="Conductor" />
                      <PendingButton type="submit" actionId="saveVehicle" pendingAction={pendingAction} className="btn btn-primary xl:col-span-4" pendingLabel="Guardando...">
                        <PlusCircle size={18} /> Agregar vehículo autorizado
                      </PendingButton>
                    </form>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="uploadVehicles" className="block text-sm font-medium text-gray-700 mb-1">Carga masiva (XLSX/CSV)</label>
                        <input type="file" id="uploadVehicles" accept=".csv, .xlsx" onChange={(e) => handleFileChange(e, 'vehicles')} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
                        <PendingButton
                          type="button"
                          actionId="upload-vehicles"
                          pendingAction={pendingAction}
                          className="btn btn-secondary mt-2 w-full"
                          disabled={!selectedVehiclesFile}
                          pendingLabel="Subiendo..."
                          onClick={() => handleUploadFleetData('vehicles')}
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
              )}

              {adminSection === 'fleet' && hasPermission(currentUser, 'fleet.upload') && (
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
              )}

              {adminSection === 'roles' && (hasPermission(currentUser, 'roles.view') || hasPermission(currentUser, 'roles.manage')) && (
                <RolesAdminPanel
                  authToken={authToken}
                  currentUser={currentUser}
                  onSuccess={showSuccess}
                  onError={showError}
                />
              )}

              {adminSection === 'permissions' && hasPermission(currentUser, 'settings.permissions') && (
                <div className="admin-sub-section">
                  <h3 className="text-xl font-medium text-gray-800 mb-3">Permisos por rol</h3>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-100">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs uppercase">Permiso</th>
                          {permissionMatrixRoles.map((role) => (
                            <th key={role.id} className="px-4 py-2 text-center text-xs uppercase">{role.label || role.id}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(permissionKeys.length ? permissionKeys : Object.keys(PERMISSION_LABELS)).map((permission) => (
                          <tr key={permission} className="border-t">
                            <td className="px-4 py-2 text-sm">{PERMISSION_LABELS[permission] || permission}</td>
                            {permissionMatrixRoles.map((role) => (
                              <td key={role.id} className="px-4 py-2 text-center">
                                <input
                                  type="checkbox"
                                  checked={(rolePermissions[role.id] || []).includes(permission)}
                                  onChange={() => toggleRolePermission(role.id, permission)}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <PendingButton type="button" actionId="saveRolePermissions" pendingAction={pendingAction} className="btn btn-primary mt-4" pendingLabel="Guardando permisos..." onClick={handleSaveRolePermissions}>
                    <Save size={18} /> Guardar permisos por rol
                  </PendingButton>
                </div>
              )}

              {editingUser && (
                <div className="modal-overlay">
                  <div className="modal-content max-w-2xl">
                    <button type="button" className="close-button" onClick={() => setEditingUser(null)} aria-label="Cerrar">
                      <XCircle size={24} />
                    </button>
                    <h3 className="text-xl font-semibold text-gray-800 mb-4">Editar usuario: {editingUser.username}</h3>
                    <form onSubmit={handleSaveUserEdit} className="space-y-4">
                      <input type="text" id="editedUsername" value={editedUsername} className="input-field" disabled />
                      {hasPermission(currentUser, 'users.edit') && canManageTargetUser(currentUser, editingUser) && (
                        <select id="editedUserRole" value={editedUserRole} onChange={(e) => setEditedUserRole(e.target.value)} className="input-field bg-white" disabled={editingUser.id === currentUser.id}>
                          {assignableRoles.map((role) => (
                            <option key={role.id} value={role.id}>{role.label}</option>
                          ))}
                        </select>
                      )}
                      <input type="password" id="editedUserPassword" value={editedUserPassword} onChange={(e) => setEditedUserPassword(e.target.value)} className="input-field" placeholder="Nueva contraseña (opcional)" />
                      {hasPermission(currentUser, 'users.edit') && canManageTargetUser(currentUser, editingUser) && (
                        <button type="button" onClick={() => setEditedUserActive(!editedUserActive)} className={`flex items-center gap-2 px-4 py-2 rounded-md ${editedUserActive ? 'bg-green-500 text-white' : 'bg-gray-300 text-gray-700'}`} disabled={editingUser.id === currentUser.id}>
                          {editedUserActive ? <ToggleRight size={20} /> : <ToggleLeft size={20} />} {editedUserActive ? 'Activo' : 'Inactivo'}
                        </button>
                      )}
                      {hasPermission(currentUser, 'settings.permissions') && (
                        <div>
                          <h4 className="font-medium mb-2">Permisos personalizados</h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto border rounded-md p-3">
                            {(permissionKeys.length ? permissionKeys : Object.keys(PERMISSION_LABELS)).map((permission) => (
                              <label key={permission} className="flex items-center gap-2 text-sm">
                                <input type="checkbox" checked={editingUserPermissions.includes(permission)} onChange={() => toggleEditingUserPermission(permission)} />
                                {PERMISSION_LABELS[permission] || permission}
                              </label>
                            ))}
                          </div>
                          <PendingButton type="button" actionId="saveUserPermissions" pendingAction={pendingAction} className="btn btn-secondary mt-3" pendingLabel="Guardando..." onClick={handleSaveUserPermissions}>
                            Guardar permisos personalizados
                          </PendingButton>
                        </div>
                      )}
                      <div className="flex justify-end gap-3">
                        <button type="button" onClick={() => setEditingUser(null)} className="btn btn-secondary"><XCircle size={20} /> Cancelar</button>
                        <PendingButton type="submit" actionId="saveUserEdit" pendingAction={pendingAction} className="btn btn-primary" pendingLabel="Guardando...">
                          <Save size={20} /> Guardar cambios
                        </PendingButton>
                      </div>
                    </form>
                  </div>
                </div>
              )}
                </div>
              </div>
            </div>
    </>
  );
}

export default AdminPage;
