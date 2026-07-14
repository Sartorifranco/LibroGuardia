/**
 * Puente local: vigila una carpeta y sincroniza planillas Excel de citados con Libro de Guardia.
 *
 * Uso típico en la PC del encargado de transporte:
 * 1. Copiar citaciones-bridge.config.example.json -> citaciones-bridge.config.json
 * 2. Configurar watchFolder (ej. C:\CitacionesTransporte)
 * 3. Configurar bridgeSecret igual al del panel Admin > Autorizaciones
 * 4. npm install (en scripts/)
 * 5. node citaciones-folder-bridge.js
 *
 * Cada archivo nuevo o modificado (.xlsx/.xls/.csv) se envía a /api/bridge/citaciones/sync
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const chokidar = require('chokidar');
const XLSX = require('xlsx');

const CONFIG_PATH = path.join(__dirname, 'citaciones-bridge.config.json');
const STATE_PATH = path.join(__dirname, '.citaciones-bridge-state.json');

const loadJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const saveJson = (filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};

const log = (message, config) => {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (config?.logFile) {
    const logPath = path.isAbsolute(config.logFile)
      ? config.logFile
      : path.join(__dirname, config.logFile);
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  }
};

const fileSignature = (filePath, stats) =>
  crypto.createHash('sha1').update(`${filePath}|${stats.size}|${stats.mtimeMs}`).digest('hex');

const isSupportedFile = (filePath, extensions, fileNamePrefix) => {
  const baseName = path.basename(filePath);
  if (fileNamePrefix && !baseName.toLowerCase().startsWith(String(fileNamePrefix).toLowerCase())) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (extensions.includes(ext)) return true;
  // Algunos sistemas guardan Excel sin extensión visible (ej. Citaciones_2025_12_20)
  if (!ext && fileNamePrefix && baseName.toLowerCase().startsWith(String(fileNamePrefix).toLowerCase())) {
    return true;
  }
  return false;
};

const readSpreadsheetRows = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.csv' || !ext) {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const transportLines = lines.filter((line) => /^\d{3,5},/.test(line));
    if (transportLines.length) {
      return transportLines.map((line) => ({ _transportCsv: line }));
    }
  }

  if (ext === '.csv') {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const firstLine = raw.split(/\r?\n/).find((line) => line.trim()) || '';
    const semicolonCount = (firstLine.match(/;/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    const delimiter = semicolonCount > commaCount ? ';' : ',';
    const workbook = XLSX.read(raw, { type: 'string', FS: delimiter, cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  }

  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  if (rows.length && Object.keys(rows[0] || {}).length === 1) {
    const firstKey = Object.keys(rows[0])[0];
    if (/^\d{3,5},/.test(String(firstKey))) {
      return rows.map((row) => {
        const line = Object.keys(row).find((key) => /^\d{3,5},/.test(String(key)))
          || Object.values(row).find((value) => /^\d{3,5},/.test(String(value)));
        return line ? { _transportCsv: String(line).replace(/^Legajo\s+/i, '') } : row;
      }).filter((row) => row._transportCsv || Object.values(row).some((v) => String(v).trim()));
    }
  }
  return rows;
};

const waitForStableFile = async (filePath, stableMs) => {
  let lastSize = -1;
  let stableSince = Date.now();

  while (Date.now() - stableSince < stableMs) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      throw new Error('Archivo no disponible (¿aún descargándose?)');
    }
    if (stats.size !== lastSize) {
      lastSize = stats.size;
      stableSince = Date.now();
    }
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableHttpStatus = (status) => [429, 502, 503, 504].includes(status);

const postBridgeSync = async (config, body, maxAttempts = 4) => {
  const url = `${config.apiBaseUrl.replace(/\/$/, '')}/bridge/citaciones/sync`;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.bridgeSecret}`
        },
        body: JSON.stringify(body)
      });

      const payload = await response.json().catch(() => ({}));
      if (response.ok) return payload;

      lastError = new Error(payload.message || `HTTP ${response.status}`);
      if (!isRetryableHttpStatus(response.status) || attempt === maxAttempts) {
        throw lastError;
      }

      const waitMs = attempt * 5000;
      log(`Reintento ${attempt}/${maxAttempts - 1} en ${waitMs / 1000}s (${lastError.message})`, config);
      await sleep(waitMs);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) throw err;
      const waitMs = attempt * 5000;
      log(`Error de red, reintento ${attempt}/${maxAttempts - 1} en ${waitMs / 1000}s (${err.message})`, config);
      await sleep(waitMs);
    }
  }

  throw lastError || new Error('Error desconocido al sincronizar');
};

const syncFile = async (filePath, config, state) => {
  const stats = fs.statSync(filePath);
  const signature = fileSignature(filePath, stats);
  if (state.processed[signature]) {
    return { skipped: true, reason: 'already_processed' };
  }

  await waitForStableFile(filePath, config.stableMs || 2500);
  const rows = readSpreadsheetRows(filePath);
  if (!rows.length) {
    throw new Error('La planilla no tiene filas');
  }

  const payload = await postBridgeSync(config, {
    sourceFile: path.basename(filePath),
    data: rows,
    defaults: config.defaults || { type: 'citacion' }
  });

  state.processed[signature] = {
    file: path.basename(filePath),
    at: new Date().toISOString(),
    count: payload.count || 0
  };
  state.lastSuccess = {
    file: path.basename(filePath),
    at: new Date().toISOString(),
    ...payload
  };
  saveJson(STATE_PATH, state);

  if (config.moveProcessedTo) {
    const destDir = config.moveProcessedTo;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, path.basename(filePath));
    fs.renameSync(filePath, destPath);
  }

  return { skipped: false, payload };
};

const createStatusServer = (getStatus, port, logFn) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus(), null, 2));
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logFn(`Puerto ${port} en uso; estado local deshabilitado (el puente sigue activo).`);
      return;
    }
    console.error(err);
  });

  server.listen(port, '127.0.0.1');
  return server;
};

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Falta ${CONFIG_PATH}. Copie citaciones-bridge.config.example.json y edítelo.`);
    process.exit(1);
  }

  const config = loadJson(CONFIG_PATH, {});
  if (!config.watchFolder || !config.apiBaseUrl || !config.bridgeSecret) {
    console.error('Config incompleta: watchFolder, apiBaseUrl y bridgeSecret son obligatorios.');
    process.exit(1);
  }

  if (!fs.existsSync(config.watchFolder)) {
    fs.mkdirSync(config.watchFolder, { recursive: true });
    log(`Carpeta creada: ${config.watchFolder}`, config);
  }

  const extensions = (config.fileExtensions || ['.xlsx', '.xls', '.csv']).map((ext) => ext.toLowerCase());
  const state = loadJson(STATE_PATH, { processed: {}, lastSuccess: null, lastError: null });
  let processing = new Set();
  let fileQueue = Promise.resolve();
  let runtimeStatus = {
    service: 'citaciones-folder-bridge',
    watching: config.watchFolder,
    apiBaseUrl: config.apiBaseUrl,
    processing: []
  };

  const processPath = (filePath) => {
    if (processing.has(filePath)) return;
    if (!isSupportedFile(filePath, extensions, config.fileNamePrefix)) return;

    processing.add(filePath);
    runtimeStatus.processing = [...processing];

    fileQueue = fileQueue.then(async () => {
      try {
        log(`Procesando: ${path.basename(filePath)}`, config);
        const result = await syncFile(filePath, config, state);
        if (result.skipped) {
          log(`Omitido (ya procesado): ${path.basename(filePath)}`, config);
        } else {
          log(`OK ${path.basename(filePath)} -> ${result.payload.message}`, config);
        }
        state.lastError = null;
        saveJson(STATE_PATH, state);
      } catch (err) {
        state.lastError = {
          file: path.basename(filePath),
          at: new Date().toISOString(),
          message: err.message
        };
        saveJson(STATE_PATH, state);
        log(`ERROR ${path.basename(filePath)}: ${err.message}`, config);
      } finally {
        processing.delete(filePath);
        runtimeStatus.processing = [...processing];
        const pauseMs = config.pauseBetweenFilesMs || 3000;
        if (pauseMs > 0) await sleep(pauseMs);
      }
    });
  };

  const watcher = chokidar.watch(config.watchFolder, {
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: config.stableMs || 2500,
      pollInterval: 300
    },
    depth: 0
  });

  watcher.on('add', processPath);
  watcher.on('change', processPath);

  createStatusServer(() => ({
    ...runtimeStatus,
    lastSuccess: state.lastSuccess,
    lastError: state.lastError,
    processedCount: Object.keys(state.processed || {}).length
  }), config.statusPort || 5023, (message) => log(message, config));

  log(`Escuchando carpeta: ${config.watchFolder}`, config);
  if (config.fileNamePrefix) {
    log(`Solo archivos que empiezan con: ${config.fileNamePrefix}`, config);
  }
  log(`API: ${config.apiBaseUrl}`, config);
  log(`Estado local: http://127.0.0.1:${config.statusPort || 5023}`, config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
