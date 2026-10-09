import React, { useState } from 'react';

/**
 * Encabezado de una pantalla de administración.
 * @param {{ title: string, purpose?: string, howTo?: string[], action?: import('react').ReactNode }} props
 */
export function PageHeader({ title, purpose, howTo = [], action = null }) {
  const [open, setOpen] = useState(false);
  const steps = (Array.isArray(howTo) ? howTo : []).filter(Boolean).slice(0, 3);

  return (
    <header className="aui-page-head">
      <div className="aui-page-head__text">
        <h3 className="aui-page-head__title">{title}</h3>
        {purpose ? <p className="aui-page-head__purpose">{purpose}</p> : null}
        {steps.length > 0 ? (
          <div className="aui-howto">
            <button
              type="button"
              className="aui-howto__toggle"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              Cómo se usa
            </button>
            {open ? (
              <ol className="aui-howto__list">
                {steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </div>
      {action ? <div className="aui-page-head__action">{action}</div> : null}
    </header>
  );
}
