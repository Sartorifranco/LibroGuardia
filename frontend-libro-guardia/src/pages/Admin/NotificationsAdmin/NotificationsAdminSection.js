import React from 'react';
import NotificationsAdminPanel from '../../../components/NotificationsAdminPanel';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';

function NotificationsAdminSection({ pendingAction, runAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();

  if (!hasPermission(currentUser, 'notifications.config')) return null;

  return (
    <NotificationsAdminPanel
      authToken={authToken}
      pendingAction={pendingAction}
      onPending={runAction}
      onSuccess={showSuccess}
      onError={showError}
    />
  );
}

export default NotificationsAdminSection;
