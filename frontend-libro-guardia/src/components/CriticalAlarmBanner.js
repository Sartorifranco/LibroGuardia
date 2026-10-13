import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useGuardAlarms } from '../context/GuardAlarmsContext';
import { guideFor } from '../utils/alarmGuide';
import { guardiaPath } from '../utils/navigation';

function CriticalAlarmBanner() {
  const { alarms } = useGuardAlarms();
  const navigate = useNavigate();
  const critical = alarms.filter((alarm) => guideFor(alarm).critical);
  if (!critical.length) return null;
  const guide = guideFor(critical[0]);
  const extra = critical.length > 1 ? ` Hay ${critical.length - 1} más.` : '';

  return (
    <div className="critical-alarm-banner" role="alert">
      <p>
        <strong>Alarma: {guide.label}.</strong>
        {' '}
        {guide.action}
        {extra}
      </p>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => navigate(guardiaPath('alarmas'))}
      >
        Ver alarmas
      </button>
    </div>
  );
}

export default CriticalAlarmBanner;
