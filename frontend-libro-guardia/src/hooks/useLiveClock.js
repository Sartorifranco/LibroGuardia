import { useEffect, useState } from 'react';

function pad(n) {
  return String(n).padStart(2, '0');
}

export function useLiveClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());

  return {
    now,
    timeDisplay: `${hours}:${minutes}:${seconds}`,
    timeInputValue: `${hours}:${minutes}`,
    dateDisplay: now.toLocaleDateString('es-AR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
    shortDateDisplay: now.toLocaleDateString('es-AR'),
  };
}
