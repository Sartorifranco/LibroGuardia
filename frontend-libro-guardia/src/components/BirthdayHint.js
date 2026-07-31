import React, { useEffect, useState } from 'react';
import { Cake } from 'lucide-react';
import { apiFetch } from '../services/api';

/**
 * Aviso sutil de cumpleaños en el home del guardia.
 * No ocupa espacio operativo: una línea compacta.
 */
function BirthdayHint({ authToken }) {
  const [names, setNames] = useState([]);

  useEffect(() => {
    if (!authToken) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch('/nomina/birthdays-today', {
          token: authToken,
          allowForbidden: true
        });
        if (!cancelled) {
          setNames((data.birthdays || []).map((b) => b.name).filter(Boolean));
        }
      } catch {
        if (!cancelled) setNames([]);
      }
    })();
    return () => { cancelled = true; };
  }, [authToken]);

  if (!names.length) return null;

  const label = names.length === 1
    ? `Hoy cumple años ${names[0]}`
    : `Hoy cumplen años ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` y ${names.length - 3} más` : ''}`;

  return (
    <p className="guard-birthday-hint" role="status">
      <Cake size={14} aria-hidden />
      <span>{label}</span>
    </p>
  );
}

export default BirthdayHint;
