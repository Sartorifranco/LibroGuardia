const PREFIX = 'mss-site-plan:v';

const planKey = (version) => `${PREFIX}${version}`;

const removeOthers = (keep) => {
  for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith(PREFIX) && key !== keep) window.localStorage.removeItem(key);
  }
};

export function readCachedPlan(version) {
  if (version == null) return null;
  try {
    const raw = window.localStorage.getItem(planKey(version));
    const plan = raw ? JSON.parse(raw) : null;
    return plan && plan.imageDataUrl && plan.version === version ? plan : null;
  } catch {
    return null;
  }
}

export function writeCachedPlan(plan) {
  try {
    if (!plan) {
      removeOthers(null);
      return;
    }
    const key = planKey(plan.version);
    removeOthers(key);
    window.localStorage.setItem(key, JSON.stringify(plan));
  } catch {
    // Sin lugar en el navegador: se vuelve a bajar la próxima vez.
  }
}
