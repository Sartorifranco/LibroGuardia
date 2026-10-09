import React from 'react';
import './admin-simple.css';

/**
 * Pasos de un asistente.
 * @param {{ steps: string[], current: number }} props
 */
export function Stepper({ steps = [], current = 0 }) {
  return (
    <ol className="admin-simple-stepper" aria-label="Pasos">
      {steps.map((step, index) => {
        let state = '';
        if (index < current) state = ' is-done';
        else if (index === current) state = ' is-current';
        return (
          <li key={step} className={`admin-simple-stepper__step${state}`} aria-current={index === current ? 'step' : undefined}>
            <span className="admin-simple-stepper__num">{index + 1}</span>
            <span>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default Stepper;
