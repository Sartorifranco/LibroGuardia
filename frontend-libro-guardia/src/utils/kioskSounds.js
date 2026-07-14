/**
 * Sonidos cortos del kiosco de acceso (Web Audio API, sin assets externos).
 * Un solo tono activo a la vez: al reproducir uno nuevo se corta el anterior.
 */

let audioCtx = null;
/** @type {Array<{ stop: () => void }>} */
let activeNodes = [];

function getAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  return audioCtx;
}

/** Reanuda el AudioContext tras inactividad / autoplay bloqueado. */
export async function unlockKioskAudio() {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  return ctx.state === 'running';
}

export function stopKioskSound() {
  for (const node of activeNodes) {
    try {
      node.stop();
    } catch {
      // ya detenido
    }
    try {
      node.disconnect();
    } catch {
      // sin conexión
    }
  }
  activeNodes = [];
}

/**
 * @param {'authorized' | 'denied'} kind
 */
export async function playKioskSound(kind) {
  stopKioskSound();
  await unlockKioskAudio();

  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.22;
  master.connect(ctx.destination);

  const scheduleTone = ({ frequency, type = 'sine', start, duration, peak = 1 }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now + start);

    const t0 = now + start;
    const t1 = t0 + duration;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t1);

    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t1 + 0.02);

    activeNodes.push(osc);
  };

  if (kind === 'authorized') {
    scheduleTone({ frequency: 880, start: 0, duration: 0.11, peak: 0.9 });
    scheduleTone({ frequency: 1320, start: 0.11, duration: 0.16, peak: 0.85 });
  } else {
    scheduleTone({ frequency: 320, start: 0, duration: 0.16, type: 'triangle', peak: 0.75 });
    scheduleTone({ frequency: 180, start: 0.16, duration: 0.22, type: 'triangle', peak: 0.7 });
  }
}
