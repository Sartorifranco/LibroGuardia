import React, { useId, useState } from 'react';

/**
 * Ayuda breve junto a un campo. Se abre con un toque (sirve en el celular).
 * @param {{ text: string }} props
 */
export function HelpTip({ text }) {
  const [open, setOpen] = useState(false);
  const tipId = useId();

  return (
    <span className="aui-help">
      <button
        type="button"
        className="aui-help__btn"
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        ?
        <span className="aui-sr">Ayuda</span>
      </button>
      {open ? (
        <span id={tipId} role="tooltip" className="aui-help__pop">{text}</span>
      ) : null}
    </span>
  );
}
