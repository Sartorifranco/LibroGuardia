import React from 'react';
import './admin-simple.css';

/**
 * Ayuda breve junto a un campo.
 * @param {{ text: string }} props
 */
export function HelpTip({ text }) {
  return (
    <span className="admin-simple-help">
      <button type="button" className="admin-simple-help__btn" aria-label={`Ayuda: ${text}`}>
        ?
      </button>
      <span className="admin-simple-help__bubble" role="tooltip">{text}</span>
    </span>
  );
}

export default HelpTip;
