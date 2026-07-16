import React from 'react';
import RolesAdminPanel from '../../../components/RolesAdminPanel';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';

/**
 * Sección "Roles": envoltorio fino de RolesAdminPanel.
 */
function RolesAdminSection() {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();

  if (!(hasPermission(currentUser, 'roles.view') || hasPermission(currentUser, 'roles.manage'))) return null;

  return (
    <RolesAdminPanel
      authToken={authToken}
      currentUser={currentUser}
      onSuccess={showSuccess}
      onError={showError}
    />
  );
}

export default RolesAdminSection;
