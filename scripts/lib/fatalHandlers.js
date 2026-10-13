/**
 * Si el proceso revienta sin catch, NSSM / la tarea programada lo vuelven a levantar.
 * Hay que salir con código 1: si el proceso queda vivo y mudo, nadie lo reinicia.
 */
const installFatalHandlers = (logFn = () => {}) => {
  const report = (kind, error) => {
    try {
      logFn('error', kind, { error });
    } catch (_err) {
      console.error(kind, error);
    }
    process.exit(1);
  };

  process.on('uncaughtException', (err) => {
    const error = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
    report('uncaughtException', error);
  });

  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error
      ? (reason.stack || reason.message)
      : String(reason);
    report('unhandledRejection', error);
  });
};

module.exports = {
  installFatalHandlers
};
