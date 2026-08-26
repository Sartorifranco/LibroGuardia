#!/usr/bin/env node
/**
 * Genera src/config/brand.js (y opcionalmente copia el logo a public/)
 * a partir de un JSON o flags. No corre en prebuild: es un paso de instalación.
 *
 *   node scripts/scaffold-brand.js --from ../clients/brand.example.json --dry-run
 *   node scripts/scaffold-brand.js --from ruta/cliente.json --force
 *   node scripts/scaffold-brand.js --company "Acme S.A." --color "#1d4ed8" --logo ./logo.png --force
 *
 * Si ya hay un companyName distinto al nuevo, hay que pasar --force.
 * brand.js se escribe al final: un fallo a mitad de camino no deja la marca a medio pisar.
 */
const fs = require('fs');
const path = require('path');
const { buildBrandConfig, renderBrandModule } = require('./buildBrandConfig');

const frontendRoot = path.join(__dirname, '..');
const brandJsPath = path.join(frontendRoot, 'src', 'config', 'brand.js');
const publicDir = path.join(frontendRoot, 'public');

const usage = () => `Uso:
  node scripts/scaffold-brand.js --from <archivo.json> [--dry-run] [--force]
  node scripts/scaffold-brand.js --company "Razón social" [--color "#rrggbb"] [--logo archivo.png] [--force]

El JSON mínimo es { "companyName": "..." }. El resto se completa con defaults de MSS.
Si brand.js ya tiene otro companyName, el script no escribe nada hasta que pases --force.
`;

const parseArgs = (argv) => {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--force') args.force = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else if (token.startsWith('--') && i + 1 < argv.length) {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    } else args._.push(token);
  }
  return args;
};

const extractCompanyName = (source) => {
  const match = String(source || '').match(/companyName\s*:\s*(['"])([\s\S]*?)\1/);
  return match ? match[2] : null;
};

const assertCanOverwriteBrand = ({
  brandFileExists,
  currentCompanyName,
  nextCompanyName,
  force
}) => {
  if (!brandFileExists) return;
  if (force) return;
  const current = String(currentCompanyName || '').trim();
  const next = String(nextCompanyName || '').trim();
  if (current && current === next) return;
  const label = current || 'marca existente';
  const err = new Error(
    `Ya hay una marca configurada (${label}). Para reemplazarla por "${next}" pasá --force.`
  );
  err.code = 'BRAND_FORCE_REQUIRED';
  throw err;
};

const loadFromFile = (fromPath) => {
  const abs = path.resolve(process.cwd(), fromPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`No existe el JSON de marca: ${abs}`);
  }
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  raw.__sourceDir = path.dirname(abs);
  return raw;
};

const resolveLogoSource = (input) => {
  const logoFile = input.logoFile || input.logo;
  if (!logoFile) return null;
  if (path.isAbsolute(logoFile)) return logoFile;
  const base = input.__sourceDir || process.cwd();
  return path.resolve(base, logoFile);
};

const uniqueSuffixPath = (targetPath) => `${targetPath}.scaffold-new`;

const cleanup = (io, files) => {
  files.forEach((file) => {
    try {
      if (file && io.existsSync(file)) io.unlinkSync(file);
    } catch (_err) {
      // best-effort
    }
  });
};

/**
 * Valida, copia el logo y recién al final reemplaza brand.js.
 * Si algo falla, brand.js queda como estaba.
 */
const applyScaffoldWrites = ({
  brand,
  source,
  logoSource,
  brandJsPath: targetBrandPath,
  publicDir: targetPublicDir,
  force = false,
  io = fs
}) => {
  const brandExists = io.existsSync(targetBrandPath);
  const currentCompanyName = brandExists
    ? extractCompanyName(io.readFileSync(targetBrandPath, 'utf8'))
    : null;

  assertCanOverwriteBrand({
    brandFileExists: brandExists,
    currentCompanyName,
    nextCompanyName: brand.companyName,
    force
  });

  if (logoSource && !io.existsSync(logoSource)) {
    throw new Error(`No existe el archivo de logo: ${logoSource}`);
  }

  const dest = path.join(targetPublicDir, path.basename(brand.logoPath));
  const brandTmp = uniqueSuffixPath(targetBrandPath);
  const logoTmp = logoSource ? uniqueSuffixPath(dest) : null;
  const logoBackup = logoSource && io.existsSync(dest) ? `${dest}.scaffold-bak` : null;

  try {
    if (logoSource) {
      if (logoBackup) io.copyFileSync(dest, logoBackup);
      io.copyFileSync(logoSource, logoTmp);
      io.copyFileSync(logoTmp, dest);
    }
    io.writeFileSync(brandTmp, source, 'utf8');
    io.copyFileSync(brandTmp, targetBrandPath);
  } catch (err) {
    if (logoBackup && io.existsSync(logoBackup)) {
      try {
        io.copyFileSync(logoBackup, dest);
      } catch (_restoreErr) {
        // brand.js still original if we failed before the last copy
      }
    }
    throw err;
  } finally {
    cleanup(io, [brandTmp, logoTmp, logoBackup]);
  }

  return { dest: logoSource ? dest : null };
};

const collectInput = (args) => {
  let input = {};
  if (args.from) input = loadFromFile(args.from);
  if (args.company) input.companyName = args.company;
  if (args.color) input.primaryColor = args.color;
  if (args.logo) input.logoFile = args.logo;
  if (args.title) input.appTitle = args.title;
  if (args.origin) input.publicOrigin = args.origin;
  return input;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const input = collectInput(args);
  const brand = buildBrandConfig(input);
  const source = renderBrandModule(brand);
  const logoSource = resolveLogoSource(input);
  const brandExists = fs.existsSync(brandJsPath);
  const currentCompanyName = brandExists
    ? extractCompanyName(fs.readFileSync(brandJsPath, 'utf8'))
    : null;

  if (args.dryRun) {
    assertCanOverwriteBrand({
      brandFileExists: brandExists,
      currentCompanyName,
      nextCompanyName: brand.companyName,
      force: args.force
    });
    if (logoSource && !fs.existsSync(logoSource)) {
      throw new Error(`No existe el archivo de logo: ${logoSource}`);
    }
    process.stdout.write(`${source}\n`);
    if (logoSource) process.stdout.write(`# copiaría logo ${logoSource} → public${brand.logoPath}\n`);
    process.stdout.write(`# escribiría ${brandJsPath}\n`);
    return;
  }

  const written = applyScaffoldWrites({
    brand,
    source,
    logoSource,
    brandJsPath,
    publicDir,
    force: args.force
  });
  process.stdout.write(`[scaffold-brand] escrito ${path.relative(frontendRoot, brandJsPath)}\n`);
  if (written.dest) {
    process.stdout.write(`[scaffold-brand] logo copiado a public${brand.logoPath}\n`);
  }
  process.stdout.write('[scaffold-brand] favicons: reemplazá a mano en public/ o corré scripts/generate-favicon.js si tenés sharp.\n');
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  resolveLogoSource,
  extractCompanyName,
  assertCanOverwriteBrand,
  applyScaffoldWrites
};
