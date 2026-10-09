import React from 'react';

const WIDTHS = new Set(['narrow', 'medium', 'wide', 'full']);

/**
 * Limita el ancho del contenido y lo alinea a la izquierda del panel.
 * narrow 720 · medium 960 · wide 1200 · full sin tope.
 */
export function PageContainer({ width = 'medium', children }) {
  const key = WIDTHS.has(width) ? width : 'medium';
  return (
    <div className={`aui-page aui-page--${key}`}>
      {children}
    </div>
  );
}

export default PageContainer;
