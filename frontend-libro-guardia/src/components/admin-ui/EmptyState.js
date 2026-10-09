import React from 'react';
import './admin-simple.css';

/**
 * Estado vacío con explicación y la acción para empezar.
 * @param {{ title: string, text?: string, actionLabel?: string, onAction?: () => void }} props
 */
export function EmptyState({ title, text, actionLabel, onAction }) {
  return (
    <div className="admin-simple-empty" role="status">
      <h3 className="admin-simple-empty__title">{title}</h3>
      {text ? <p className="admin-simple-empty__text">{text}</p> : null}
      {actionLabel && onAction ? (
        <button type="button" className="btn btn-primary" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export default EmptyState;
