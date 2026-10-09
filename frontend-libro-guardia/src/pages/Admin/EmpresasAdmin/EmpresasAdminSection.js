import React, { useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import PageHeader from '../../../components/admin-ui/PageHeader';
import EmptyState from '../../../components/admin-ui/EmptyState';
import AdvancedSection from '../../../components/admin-ui/AdvancedSection';
import HelpTip from '../../../components/admin-ui/HelpTip';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';

/** Dominio canónico: host sin @, minúsculas (mismo criterio que el backend). */
function normalizeDomainInput(raw) {
  let value = String(raw || '').trim().toLowerCase();
  if (value.includes('@')) value = value.split('@').pop() || '';
  return value.replace(/\.+$/, '').trim();
}

function EmpresasAdminSection({ pendingAction, runAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { confirm } = useConfirm();

  const [empresas, setEmpresas] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [nombre, setNombre] = useState('');
  const [dominiosText, setDominiosText] = useState('');
  const [activa, setActiva] = useState(true);
  const [query, setQuery] = useState('');

  const canManage = hasPermission(currentUser, 'empresas.manage');

  const load = async () => {
    if (!canManage) return;
    try {
      const data = await apiFetch('/admin/empresas', { token: authToken, allowForbidden: true });
      setEmpresas(data.empresas || []);
    } catch (err) {
      showError(err.message || 'No se pudieron cargar las empresas');
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, canManage]);

  const resetForm = () => {
    setEditingId(null);
    setNombre('');
    setDominiosText('');
    setActiva(true);
  };

  const startEdit = (emp) => {
    setEditingId(emp.id);
    setNombre(emp.nombre || '');
    setDominiosText((emp.dominiosPermitidos || []).join(', '));
    setActiva(emp.activa !== false);
  };

  const parseDominios = () => {
    const parts = String(dominiosText || '')
      .split(/[,;\s]+/)
      .map(normalizeDomainInput)
      .filter(Boolean);
    return [...new Set(parts)];
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canManage) return;
    const dominiosPermitidos = parseDominios();
    await runAction(editingId ? 'updateEmpresa' : 'createEmpresa', async () => {
      try {
        if (editingId) {
          const data = await apiFetch(`/admin/empresas/${editingId}`, {
            method: 'PUT',
            token: authToken,
            body: { nombre, dominiosPermitidos, activa }
          });
          setEmpresas((prev) => prev.map((x) => (x.id === editingId ? data.empresa : x)));
          showSuccess('Empresa actualizada');
        } else {
          const data = await apiFetch('/admin/empresas', {
            method: 'POST',
            token: authToken,
            body: { nombre, dominiosPermitidos, activa }
          });
          setEmpresas((prev) => [...prev, data.empresa].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre))));
          showSuccess('Empresa creada');
        }
        resetForm();
      } catch (err) {
        showError(err.message || 'Error al guardar empresa');
      }
    });
  };

  const handleDelete = async (emp) => {
    const ok = await confirm({
      title: 'Eliminar empresa',
      message: `¿Eliminar “${emp.nombre}”? Esta acción no se puede deshacer.`,
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await apiFetch(`/admin/empresas/${emp.id}`, { method: 'DELETE', token: authToken });
      setEmpresas((prev) => prev.filter((x) => x.id !== emp.id));
      if (editingId === emp.id) resetForm();
      showSuccess('Empresa eliminada');
    } catch (err) {
      showError(err.message || 'Error al eliminar');
    }
  };

  if (!canManage) {
    return <p className="theme-section-desc">No tenés permiso para cargar empresas.</p>;
  }

  const filtered = empresas.filter((emp) => {
    const blob = `${emp.nombre || ''} ${(emp.dominiosPermitidos || []).join(' ')}`.toLowerCase();
    return blob.includes(query.trim().toLowerCase());
  });

  return (
    <div className="empresas-admin admin-simple">
      <PageHeader
        title="Empresas y responsables"
        purpose="Las empresas del predio y los mails con los que su gente puede pedir visitas."
        howTo={[
          'Cargá el nombre de la empresa.',
          'Agregá los mails que usa (por ejemplo empresa.com.ar).',
          'Guardá. Después el responsable entra con ese mail y carga las visitas.'
        ]}
        action={(
          <PendingButton
            type="submit"
            form="empresa-form"
            className="btn btn-primary"
            actionId={editingId ? 'updateEmpresa' : 'createEmpresa'}
            pendingAction={pendingAction}
          >
            {editingId ? 'Guardar cambios' : 'Guardar empresa'}
          </PendingButton>
        )}
      />

      <form id="empresa-form" onSubmit={handleSubmit} className="admin-form-card space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="empresaNombre">Nombre de la empresa</label>
          <input
            id="empresaNombre"
            className="input-field"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="empresaDominios">
            Mails de la empresa
            <HelpTip text="Si alguien se anota con un mail de esta empresa, queda como responsable para cargar visitas." />
          </label>
          <input
            id="empresaDominios"
            className="input-field"
            value={dominiosText}
            onChange={(e) => setDominiosText(e.target.value)}
            placeholder="empresa.com.ar, otra.com"
            aria-label="Mails de la empresa"
          />
          <p className="historial-meta" style={{ marginTop: '0.35rem' }}>
            Escribí lo que va después de la @, separado por coma. Si pegás nombre@empresa.com se toma solo empresa.com.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={activa} onChange={(e) => setActiva(e.target.checked)} />
          La empresa puede cargar visitas
        </label>
        {editingId ? (
          <button type="button" className="btn btn-secondary" onClick={resetForm}>
            Cancelar
          </button>
        ) : null}
      </form>

      <div className="admin-simple-search" style={{ marginTop: '1rem' }}>
        <input
          className="input-field"
          type="search"
          aria-label="Buscar empresa"
          placeholder="Buscar por nombre o mail"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={empresas.length === 0 ? 'Todavía no cargaste empresas' : 'Ninguna empresa coincide'}
          text={empresas.length === 0
            ? 'Una empresa agrupa a su gente y los mails con los que pueden pedir visitas.'
            : 'Probá con otro nombre.'}
          actionLabel={empresas.length === 0 ? 'Cargar la primera' : undefined}
          onAction={empresas.length === 0 ? () => document.getElementById('empresaNombre')?.focus() : undefined}
        />
      ) : (
        <ul className="user-list">
          {filtered.map((emp) => (
            <li key={emp.id} className="user-list-item">
              <div>
                <strong>{emp.nombre}</strong>
                <p className="historial-meta">
                  {(emp.dominiosPermitidos || []).join(', ') || 'Sin mails'}
                  {' · '}
                  {emp.activa === false ? 'Pausada' : 'Puede cargar visitas'}
                </p>
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn btn-secondary" onClick={() => startEdit(emp)}>
                  <Pencil size={14} /> Editar
                </button>
                <button type="button" className="btn btn-danger-small" aria-label={`Eliminar ${emp.nombre}`} onClick={() => handleDelete(emp)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AdvancedSection>
        <p>
          El responsable entra en la pantalla de registro con un mail de la empresa, crea su usuario y después carga visitas.
          Si pausás la empresa, no entran responsables nuevos. Las cuentas que ya existen siguen.
        </p>
      </AdvancedSection>
    </div>
  );
}

export default EmpresasAdminSection;
