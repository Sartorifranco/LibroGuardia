import React from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/admin-ui';
import { useAuth } from '../../../context/AuthContext';
import { canAccessGuardia, hasPermission } from '../../../utils/permissions';
import { guardiaPath } from '../../../utils/navigation';
import VisitasAdminSection from '../VisitasAdmin/VisitasAdminSection';

/** Bandeja operativa y, si hace falta, la cola de visitas pedidas por empleados. */
function AutorizacionesHub() {
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const canTray = canAccessGuardia(currentUser);
  const canVisitas = hasPermission(currentUser, 'visitas.approve');

  return (
    <div>
      <PageHeader
        title="Autorizaciones"
        purpose="Pedidos de ingreso y visitas que un empleado pidió y todavía no confirmaste."
        howTo={[
          'Abrí la bandeja para responder un pedido de ingreso.',
          'Si hay una visita pedida por un empleado, confirmala o rechazala acá.',
          'Hasta que la confirmes, esa visita no puede entrar.'
        ]}
        action={canTray ? (
          <button type="button" className="btn btn-primary" onClick={() => navigate(guardiaPath('autorizaciones'))}>
            Abrir la bandeja
          </button>
        ) : null}
      />
      {canVisitas ? <VisitasAdminSection /> : null}
    </div>
  );
}

export default AutorizacionesHub;
