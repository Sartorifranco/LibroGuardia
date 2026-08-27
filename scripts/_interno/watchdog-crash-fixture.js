const http = require('node:http');

const port = Number(process.argv[2] || process.env.WATCHDOG_FIXTURE_PORT || 15022);
const crashAfterMs = Number(process.argv[3] || process.env.WATCHDOG_FIXTURE_CRASH_MS || 5000);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, pid: process.pid }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[watchdog-fixture] listening port=${port} pid=${process.pid}`);
  setTimeout(() => {
    console.error(`[watchdog-fixture] intentional crash after ${crashAfterMs}ms`);
    process.exit(1);
  }, crashAfterMs);
});
