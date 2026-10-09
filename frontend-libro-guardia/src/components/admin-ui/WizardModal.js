import React, { useEffect, useState } from 'react';
import Modal from './Modal';
import Stepper from './Stepper';

/**
 * Modal con pasos numerados. Botones Atrás, Continuar y finishLabel.
 * Un paso puede definir `onContinue` async: si devuelve false, no avanza.
 */
export function WizardModal({
  open,
  title,
  steps = [],
  onClose,
  onFinish,
  finishLabel = 'Terminar'
}) {
  const [index, setIndex] = useState(0);
  const list = Array.isArray(steps) ? steps : [];
  const safeIndex = Math.min(Math.max(index, 0), Math.max(list.length - 1, 0));
  const step = list[safeIndex] || { title: '', content: null, canContinue: true };
  const last = list.length === 0 || safeIndex >= list.length - 1;
  const canContinue = step.canContinue !== false;

  useEffect(() => {
    if (!open) setIndex(0);
  }, [open]);

  const goBack = () => {
    if (safeIndex === 0) onClose?.();
    else setIndex((current) => Math.max(0, current - 1));
  };

  const goNext = async () => {
    if (!canContinue) return;
    if (typeof step.onContinue === 'function') {
      const ok = await step.onContinue();
      if (ok === false) return;
    }
    if (last) onFinish?.();
    else setIndex((current) => current + 1);
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size="md"
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={goBack}>
            {safeIndex === 0 ? 'Cancelar' : 'Atrás'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={goNext}
            disabled={!canContinue}
          >
            {last ? finishLabel : 'Continuar'}
          </button>
        </>
      )}
    >
      <Stepper steps={list.map((item) => item.title)} current={safeIndex} />
      <div key={step.id || safeIndex}>{step.content}</div>
    </Modal>
  );
}

export default WizardModal;
