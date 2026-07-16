import React from 'react';
import DoorsAdminPanel from '../../../components/DoorsAdminPanel';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';

/**
 * Sección "Puertas y acceso": envoltorio fino de DoorsAdminPanel.
 * @param {{ pendingAction: string|null, runAction: Function, onAccessConfigSaved?: (cfg: object) => void }} props
 */
function DoorsAdminSection({ pendingAction, runAction, onAccessConfigSaved }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();

  if (!(hasPermission(currentUser, 'access.doors.manage') || hasPermission(currentUser, 'access.control'))) return null;

  return (
    <DoorsAdminPanel
      authToken={authToken}
      pendingAction={pendingAction}
      onPending={runAction}
      onSuccess={showSuccess}
      onError={showError}
      onGlobalAccessSaved={(cfg) => { onAccessConfigSaved?.(cfg); }}
    />
  );
}

export default DoorsAdminSection;
