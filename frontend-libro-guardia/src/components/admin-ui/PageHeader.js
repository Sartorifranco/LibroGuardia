import React from 'react';

/**
 * Encabezado de una pantalla de administración.
 * @param {{ title: string, purpose?: string, howTo?: string[], action?: import('react').ReactNode }} props
 */
export function PageHeader({ title, purpose, howTo = [], action = null }) {
  const steps = (Array.isArray(howTo) ? howTo : []).filter(Boolean).slice(0, 3);

  return (
    <header className="aui-page-head">
      <div className="aui-page-head__text">
        <h3 className="aui-page-head__title">{title}</h3>
        {purpose ? (
          <p className="aui-page-head__purpose">
            <strong>Para qué sirve:</strong> {purpose}
          </p>
        ) : null}
        {steps.length > 0 ? (
          <details className="aui-howto">
            <summary className="aui-howto__toggle">Cómo se usa</summary>
            <ol className="aui-howto__list">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
      {action ? <div className="aui-page-head__action">{action}</div> : null}
    </header>
  );
}

export default PageHeader;
