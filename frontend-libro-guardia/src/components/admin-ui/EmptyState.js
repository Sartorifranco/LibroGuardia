import React from 'react';

/**
 * Estado vacío con explicación y la acción para empezar.
 * @param {{ title: string, text?: string, actionLabel?: string, onAction?: () => void }} props
 */
export function EmptyState({ title, text, actionLabel, onAction }) {
  return (
    <div className="aui-empty" role="status">
      <strong className="aui-empty__title">{title}</strong>
      {text ? <p className="aui-empty__text">{text}</p> : null}
      {actionLabel && onAction ? (
        <button type="button" className="btn btn-primary aui-empty__action" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export default EmptyState;
