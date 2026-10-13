import React from 'react';
import ActivityPanel from '../../../components/ActivityPanel';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import PageHeader from '../../../components/admin-ui/PageHeader';

/**
 * Sección "Actividad": envoltorio fino de ActivityPanel.
 */
function ActivityAdminSection() {
  const { currentUser } = useAuth();

  const canView = hasPermission(currentUser, 'users.view') ||
    hasPermission(currentUser, 'roles.view') ||
    hasPermission(currentUser, 'settings.permissions') ||
    hasPermission(currentUser, 'audit.view');

  if (!canView) return null;

  return (
    <div className="admin-simple">
      <PageHeader
        title="Registro de cambios"
        purpose="Un resumen de lo que pasó: altas, cambios, bajas y visitas aprobadas."
        howTo={[
          'Leé la lista de arriba hacia abajo.',
          'Actualizá si acabás de hacer algo.',
          'Si necesitás el detalle, abrí la auditoría.'
        ]}
      />
      <ActivityPanel />
    </div>
  );
}

export default ActivityAdminSection;
