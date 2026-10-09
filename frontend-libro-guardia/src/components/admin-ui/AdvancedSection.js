import React from 'react';

/**
 * Bloque plegado para lo técnico. Cerrado por defecto.
 * @param {{ title?: string, children: import('react').ReactNode }} props
 */
export function AdvancedSection({ title = 'Opciones avanzadas', children }) {
  return (
    <details className="aui-advanced">
      <summary className="aui-advanced__summary">{title}</summary>
      <div className="aui-advanced__body">{children}</div>
    </details>
  );
}
