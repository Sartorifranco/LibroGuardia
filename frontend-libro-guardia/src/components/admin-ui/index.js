import React from 'react';
import './admin-ui.css';

export function PageHeader({ title, purpose, howTo = [], action = null }) {
  return (
    <header className="aui-pagehead">
      <div className="aui-pagehead__text">
        <h2 className="aui-pagehead__title">{title}</h2>
        {purpose ? <p className="aui-pagehead__purpose">{purpose}</p> : null}
        {howTo.length > 0 ? (
          <ol className="aui-pagehead__howto">
            {howTo.map((step) => <li key={step}>{step}</li>)}
          </ol>
        ) : null}
      </div>
      {action ? <div className="aui-pagehead__action">{action}</div> : null}
    </header>
  );
}

export function EmptyState({ title, text, actionLabel, onAction }) {
  return (
    <div className="aui-empty" role="status">
      <h3>{title}</h3>
      {text ? <p>{text}</p> : null}
      {actionLabel && onAction ? (
        <button type="button" className="aui-btn" onClick={onAction}>{actionLabel}</button>
      ) : null}
    </div>
  );
}

export function HelpTip({ text }) {
  if (!text) return null;
  return <p className="aui-helptip">{text}</p>;
}

export function AdvancedSection({ title, children }) {
  return (
    <details className="aui-advanced">
      <summary>{title}</summary>
      <div className="aui-advanced__body">{children}</div>
    </details>
  );
}
