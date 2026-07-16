import React, { useCallback, useEffect, useState } from 'react';
import {
  X,
  ChevronRight,
  ChevronLeft,
  MonitorSmartphone,
  FilePlus2,
  History,
  LayoutDashboard,
  ClipboardList,
  BadgeCheck
} from 'lucide-react';

const STORAGE_KEY = 'onboardingDone';

const STEPS = [
  {
    id: 'inicio',
    icon: LayoutDashboard,
    title: 'Inicio y paneles',
    body: 'Desde Inicio ves el estado del día: movimientos, GPS, citados y accesos. Es el centro de operación de la guardia.'
  },
  {
    id: 'acceso',
    icon: MonitorSmartphone,
    title: 'Control de Acceso',
    body: 'El Control de Acceso sirve para escanear o validar ingresos en pantalla completa. Ideal en mesa de acceso sin distracciones del panel completo.'
  },
  {
    id: 'citados',
    icon: ClipboardList,
    title: 'Citados',
    body: 'Control de asistencia: quién llegó hoy de lo esperado según las citaciones del día (por ejemplo Transporte, Tesorería y Grúas).'
  },
  {
    id: 'autorizados',
    icon: BadgeCheck,
    title: 'Autorizados',
    body: 'Permisos de acceso: quién está autorizado a entrar (visitas, temporales y pre-registro). Es distinto de la asistencia de Citados.'
  },
  {
    id: 'novedad',
    icon: FilePlus2,
    title: 'Novedades y registros',
    body: 'Usá las pestañas de Personal, Vehículo, Flota y Novedad para cargar movimientos. Cada registro queda en el historial con fecha y hora.'
  },
  {
    id: 'historial',
    icon: History,
    title: 'Historial',
    body: 'El Historial concentra todo lo registrado. Ahí filtrás por tipo, buscás por texto y exportás reportes cuando lo necesites.'
  }
];

export function isOnboardingDone() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return true;
  }
}

export function markOnboardingDone() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // ignore
  }
}

function OnboardingTour({ open, onClose, auto = false }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  const finish = useCallback(() => {
    markOnboardingDone();
    onClose?.();
  }, [onClose]);

  if (!open) return null;

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboarding-modal">
        <button type="button" className="onboarding-modal__close" onClick={finish} aria-label="Cerrar tutorial">
          <X size={18} />
        </button>
        <div className="onboarding-modal__icon">
          <Icon size={28} aria-hidden />
        </div>
        <p className="onboarding-modal__step">
          Paso {step + 1} de {STEPS.length}
          {auto ? ' · Bienvenida' : ''}
        </p>
        <h2 id="onboarding-title">{current.title}</h2>
        <p className="onboarding-modal__body">{current.body}</p>
        <div className="onboarding-modal__dots" aria-hidden>
          {STEPS.map((s, i) => (
            <span key={s.id} className={i === step ? 'is-active' : ''} />
          ))}
        </div>
        <div className="onboarding-modal__actions">
          {step > 0 ? (
            <button type="button" className="btn btn-secondary" onClick={() => setStep((s) => s - 1)}>
              <ChevronLeft size={16} /> Anterior
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={finish}>
              Omitir
            </button>
          )}
          {isLast ? (
            <button type="button" className="btn btn-primary" onClick={finish}>
              Listo
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setStep((s) => s + 1)}>
              Siguiente <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default OnboardingTour;
