import React, { useState } from 'react';
import './admin-simple.css';

/**
 * Bloque plegado para datos del instalador.
 * Los hijos se montan solo al abrir, para no disparar consultas de más.
 * @param {{ title?: string, children?: import('react').ReactNode }} props
 */
export function AdvancedSection({ title = 'Opciones avanzadas', children }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="admin-simple-advanced">
      <button
        type="button"
        className="admin-simple-advanced__toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {title}
      </button>
      {open ? <div className="admin-simple-advanced__body">{children}</div> : null}
    </section>
  );
}

export default AdvancedSection;
