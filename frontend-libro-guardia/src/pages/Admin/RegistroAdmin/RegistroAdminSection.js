import React, { useEffect, useState } from 'react';
import { PageHeader, PageContainer } from '../../../components/admin-ui';
import ActivityAdminSection from '../ActivityAdmin/ActivityAdminSection';
import AuditAdminSection from '../AuditAdmin/AuditAdminSection';

function RegistroAdminSection({ initialTipo = 'todos' }) {
  const [tipo, setTipo] = useState(initialTipo || 'todos');

  useEffect(() => {
    if (initialTipo) setTipo(initialTipo);
  }, [initialTipo]);

  return (
    <PageContainer width="wide">
    <div>
      <PageHeader
        title="Registro de cambios"
        purpose="Acá queda quién modificó usuarios, puertas, permisos y el resto."
        howTo={[
          'Elegí el tipo si buscás solo una clase de cambio.',
          'Revisá la fecha y quién lo hizo.',
          'Si no aparece, probá el otro tipo.'
        ]}
      />
      <label className="aui-field">
        <span className="aui-field__label">Tipo</span>
        <select className="input-field" value={tipo} onChange={(event) => setTipo(event.target.value)} aria-label="Tipo de registro">
          <option value="todos">Todos</option>
          <option value="actividad">Actividad</option>
          <option value="auditoria">Auditoría</option>
        </select>
      </label>
      {tipo === 'todos' || tipo === 'actividad' ? <ActivityAdminSection /> : null}
      {tipo === 'todos' || tipo === 'auditoria' ? <AuditAdminSection /> : null}
    </div>
    </PageContainer>
  );
}

export default RegistroAdminSection;
