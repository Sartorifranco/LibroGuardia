import React from 'react';

/**
 * Pasos numerados. `current` es el índice del paso en curso (0 = primero).
 * @param {{ steps: string[], current?: number }} props
 */
export function Stepper({ steps = [], current = 0 }) {
  const list = Array.isArray(steps) ? steps : [];
  const index = Math.min(Math.max(Number(current) || 0, 0), Math.max(list.length - 1, 0));

  return (
    <ol className="aui-stepper" aria-label="Pasos">
      {list.map((label, i) => {
        const state = i < index ? 'is-done' : i === index ? 'is-current' : '';
        return (
          <li key={`${label}-${i}`} className={`aui-stepper__item ${state}`.trim()} aria-current={i === index ? 'step' : undefined}>
            <span className="aui-stepper__n" aria-hidden>{i < index ? '✓' : i + 1}</span>
            <span className="aui-stepper__label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default Stepper;
