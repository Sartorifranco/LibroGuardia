import React, { useState } from 'react';

/**
 * Bloque plegado para opciones técnicas o datos del instalador.
 * Los hijos se montan recién al abrir: no se disparan consultas (lecturas) de más.
 * @param {{ title?: string, children?: import('react').ReactNode }} props
 */
export function AdvancedSection({ title = 'Opciones avanzadas', children }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="aui-advanced">
      <button
        type="button"
        className="aui-advanced__summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {title}
      </button>
      {open ? <div className="aui-advanced__body">{children}</div> : null}
    </section>
  );
}

export default AdvancedSection;
