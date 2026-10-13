import React from 'react';
import { accessReasonText, warningText } from '../utils/accessEventText';

function EntryNotes({ entry = {} }) {
  const reason = accessReasonText(entry.accessReason);
  const warnings = (Array.isArray(entry.warnings) ? entry.warnings : [])
    .map((code) => warningText(code))
    .filter(Boolean);
  const denied = entry.accessAuthorized === false;
  if (!reason && !warnings.length && !denied) return null;

  return (
    <div className="entry-notes">
      {denied ? <p className="entry-warning entry-warning--alert">No autorizado</p> : null}
      {reason ? <p className="entry-notes__reason">{reason}</p> : null}
      {warnings.map((text, index) => (
        <p key={`${text}-${index}`} className="entry-warning">{text}</p>
      ))}
    </div>
  );
}

export default EntryNotes;
