import React from 'react';

const WIDTHS = new Set(['narrow', 'medium', 'wide', 'full']);

/**
 * Limita el ancho del contenido y lo alinea a la izquierda del panel.
 * @param {{ width?: 'narrow'|'medium'|'wide'|'full', children?: import('react').ReactNode }} props
 */
export function PageContainer({ width = 'medium', children }) {
  const key = WIDTHS.has(width) ? width : 'medium';
  return <div className={`aui-page aui-page--${key}`}>{children}</div>;
}

export default PageContainer;
