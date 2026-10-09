import React from 'react';
import './admin-simple.css';

/**
 * Encabezado de una pantalla de administración.
 * @param {{ title: string, purpose?: string, howTo?: string[], action?: import('react').ReactNode }} props
 */
export function PageHeader({ title, purpose, howTo = [], action }) {
  const steps = (Array.isArray(howTo) ? howTo : []).slice(0, 3);
  return (
    <header className="admin-simple-header">
      <div className="admin-simple-header__text">
        <h2 className="admin-simple-header__title">{title}</h2>
        {purpose ? (
          <p className="admin-simple-header__purpose">Para qué sirve: {purpose}</p>
        ) : null}
        {steps.length > 0 ? (
          <details className="admin-simple-howto">
            <summary>Cómo se usa</summary>
            <ol>
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
      {action ? <div className="admin-simple-header__action">{action}</div> : null}
    </header>
  );
}

export default PageHeader;
