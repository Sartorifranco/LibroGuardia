import React, { useEffect, useState } from 'react';
import { AdvancedSection, PageHeader, PageContainer } from '../../../components/admin-ui';
import RolesAdminSection from '../RolesAdmin/RolesAdminSection';
import PermissionsAdminSection from '../PermissionsAdmin/PermissionsAdminSection';

function RolesPermisosSection({ initialTab = 'roles', pendingAction, runAction, onPermissionKeysChange }) {
  const [tab, setTab] = useState(initialTab === 'permisos' ? 'permisos' : 'roles');

  useEffect(() => {
    setTab(initialTab === 'permisos' ? 'permisos' : 'roles');
  }, [initialTab]);

  return (
    <PageContainer width="medium">
    <div>
      <PageHeader
        title="Roles y permisos"
        purpose="Un rol es un tipo de usuario. El guardia opera. El responsable aprueba."
        howTo={[
          'Elegí el rol que querés revisar.',
          'Marcá lo que esa persona puede hacer.',
          'La matriz completa está en Permisos, adentro de opciones avanzadas.'
        ]}
      />
      <div className="aui-toolbar" role="tablist" aria-label="Roles y permisos">
        <button type="button" role="tab" aria-selected={tab === 'roles'} className={tab === 'roles' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('roles')}>
          Roles
        </button>
        <button type="button" role="tab" aria-selected={tab === 'permisos'} className={tab === 'permisos' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('permisos')}>
          Permisos
        </button>
      </div>
      {tab === 'roles' ? <RolesAdminSection /> : null}
      {tab === 'permisos' ? (
        <AdvancedSection title="Matriz detallada">
          <PermissionsAdminSection
            pendingAction={pendingAction}
            runAction={runAction}
            onPermissionKeysChange={onPermissionKeysChange}
          />
        </AdvancedSection>
      ) : null}
    </div>
    </PageContainer>
  );
}

export default RolesPermisosSection;
