const fs = require('fs');
const path = require('path');

/**
 * Escribe JSON de un saque: archivo temporal en el mismo directorio y rename.
 * Si el proceso se corta a mitad de la escritura, el archivo anterior queda intacto.
 */
const writeJsonFileAtomic = (filePath, data) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
};

module.exports = {
  writeJsonFileAtomic
};
