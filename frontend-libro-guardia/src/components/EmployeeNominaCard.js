import React from 'react';

function EmployeeNominaCard({ employee }) {
  if (!employee) return null;

  const shift = employee.shiftSchedule;
  const shiftLabel = employee.turnoRaw
    || (shift?.daysOfWeek?.length
      ? `${shift.daysOfWeek.join(', ')} ${shift.timeWindow?.from || ''}${shift.timeWindow?.to ? ` a ${shift.timeWindow.to}` : ''}`
      : 'Sin turno');

  return (
    <div className="employee-nomina-card">
      <p className="employee-nomina-card__title">{employee.name}</p>
      <div className="employee-nomina-card__grid">
        <span><strong>DNI:</strong> {employee.idNumberNormalized || employee.idNumber || '—'}</span>
        <span><strong>Legajo:</strong> {employee.legajoNormalized || employee.legajo || '—'}</span>
        <span><strong>Rol:</strong> {employee.role || '—'}</span>
        <span><strong>Centro de costo:</strong> {employee.centroCosto || employee.company || '—'}</span>
        <span><strong>Turno:</strong> {shiftLabel}</span>
        <span><strong>Citación:</strong> {employee.requiresCitacion ? 'Requiere citación del día' : 'No'}</span>
        <span className="employee-nomina-card__wide">
          <strong>Autorización:</strong> {employee.authorizationPolicy || '—'}
        </span>
      </div>
    </div>
  );
}

export default EmployeeNominaCard;
