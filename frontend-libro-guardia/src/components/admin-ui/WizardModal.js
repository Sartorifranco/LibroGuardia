import React, { useEffect, useState } from 'react';
import Modal from './Modal';
import Stepper from './Stepper';

/**
 * Modal con pasos numerados.
 * @param {{
 *   open: boolean,
 *   title: string,
 *   steps: { id: string, title: string, content: import('react').ReactNode, canContinue?: boolean }[],
 *   onClose: () => void,
 *   onFinish: () => void,
 *   finishLabel?: string
 * }} props
 */
export function WizardModal({
  open,
  title,
  steps = [],
  onClose,
  onFinish,
  finishLabel = 'Terminar'
}) {
  const list = Array.isArray(steps) ? steps : [];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(list.length - 1, 0)));
  }, [list.length]);

  const step = list[index] || null;
  const last = list.length === 0 || index >= list.length - 1;
  const canContinue = step ? step.canContinue !== false : false;

  return (
    <Modal
      open={open}
      title={title}
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-secondary" data-aui-cancel="true" onClick={onClose}>
            Cancelar
          </button>
          <div className="aui-modal__footer-right">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setIndex((current) => Math.max(0, current - 1))}
              disabled={index === 0}
            >
              Atrás
            </button>
            {last ? (
              <button type="button" className="btn btn-primary" disabled={!canContinue} onClick={onFinish}>
                {finishLabel}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canContinue}
                onClick={() => {
                  if (!canContinue) return;
                  setIndex((current) => Math.min(list.length - 1, current + 1));
                }}
              >
                Continuar
              </button>
            )}
          </div>
        </>
      )}
    >
      <Stepper steps={list.map((item) => item.title)} current={index} />
      <div key={step?.id || index}>{step?.content}</div>
    </Modal>
  );
}

export default WizardModal;
