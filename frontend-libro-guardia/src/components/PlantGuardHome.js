import React from 'react';
import DigitalDoorPanel from './DigitalDoorPanel';
import DayPassages from './DayPassages';
import GuardAlarmsPanel from './GuardAlarmsPanel';
import { useRuntime } from '../context/RuntimeContext';

function PlantGuardHome() {
  const { capabilities } = useRuntime();
  const caps = Array.isArray(capabilities) ? capabilities : [];
  const showDoors = caps.includes('doors');
  const showEntries = caps.includes('entries');
  const showAlarms = caps.includes('alarms');

  return (
    <div className="plant-home">
      <header className="plant-home__hero">
        <p className="guard-ops__eyebrow">Puesto de guardia</p>
        <h2>Planta</h2>
        <p>Puertas, pasos del día y alarmas.</p>
      </header>
      {showDoors ? (
        <DigitalDoorPanel profile="guardia" canManualOpen botoneraMode pollSeconds={15} />
      ) : null}
      {showEntries ? <DayPassages /> : null}
      {showAlarms ? <GuardAlarmsPanel compact /> : null}
    </div>
  );
}

export default PlantGuardHome;
