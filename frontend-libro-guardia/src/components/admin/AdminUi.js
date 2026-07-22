import React from 'react';
import { Inbox, Loader2 } from 'lucide-react';

/**
 * Bloque estándar del panel admin: encabezado de bloque + acción opcional.
 * El título de página lo pone AdminPage; esto es para sub-bloques (formulario / lista).
 */
export function AdminBlock({
  title,
  description,
  action = null,
  children,
  className = ''
}) {
  return (
    <section className={`admin-block${className ? ` ${className}` : ''}`}>
      {(title || action) && (
        <div className="admin-block__head">
          <div className="admin-block__head-text">
            {title ? <h4 className="admin-block__title">{title}</h4> : null}
            {description ? <p className="admin-block__desc">{description}</p> : null}
          </div>
          {action ? <div className="admin-block__action">{action}</div> : null}
        </div>
      )}
      <div className="admin-block__body">{children}</div>
    </section>
  );
}

/** Estado de carga uniforme. */
export function AdminLoading({ label = 'Cargando…' }) {
  return (
    <div className="admin-empty admin-empty--loading" role="status">
      <Loader2 className="animate-spin" size={28} aria-hidden />
      <span>{label}</span>
    </div>
  );
}

/** Estado vacío uniforme. */
export function AdminEmpty({
  icon: Icon = Inbox,
  title = 'Todavía no hay datos',
  description = 'Cuando haya información cargada, va a aparecer acá.'
}) {
  return (
    <div className="admin-empty" role="status">
      <Icon size={22} aria-hidden />
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
    </div>
  );
}

/** Tabla con estilo único del admin. */
export function AdminTable({ children, className = '' }) {
  return (
    <div className="admin-table-wrap">
      <table className={`admin-table${className ? ` ${className}` : ''}`}>{children}</table>
    </div>
  );
}

/** Formulario de alta/edición con el mismo marco visual. */
export function AdminFormCard({ children, onSubmit, className = '' }) {
  const Comp = onSubmit ? 'form' : 'div';
  return (
    <Comp
      className={`admin-form-card${className ? ` ${className}` : ''}`}
      {...(onSubmit ? { onSubmit } : {})}
    >
      {children}
    </Comp>
  );
}
