import React from 'react';
import ActivityPanel from '../../../components/ActivityPanel';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';

/**
 * Sección "Actividad": envoltorio fino de ActivityPanel.
 */
function ActivityAdminSection() {
  const { currentUser } = useAuth();

  const canView = hasPermission(currentUser, 'users.view') ||
    hasPermission(currentUser, 'roles.view') ||
    hasPermission(currentUser, 'settings.permissions');

  if (!canView) return null;

  return <ActivityPanel />;
}

export default ActivityAdminSection;
