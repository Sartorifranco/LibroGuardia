#!/usr/bin/env node
/**
 * Genera src/config/brand.js (y opcionalmente copia el logo a public/)
 * a partir de un JSON o flags. No corre en prebuild: es un paso de instalación.
 *
 *   node scripts/scaffold-brand.js --from ../clients/brand.example.json --dry-run
 *   node scripts/scaffold-brand.js --from ruta/cliente.json
 *   node scripts/scaffold-brand.js --company "Acme S.A." --color "#1d4ed8" --logo ./logo.png
 */
const fs = require('fs');
const path = require('path');
const { buildBrandConfig, renderBrandModule } = require('./buildBrandConfig');

const frontendRoot = path.join(__dirname, '..');
const brandJsPath = path.join(frontendRoot, 'src', 'config', 'brand.js');
const publicDir = path.join(frontendRoot, 'public');

const usage = () => `Uso:
  node scripts/scaffold-brand.js --from <archivo.json> [--dry-run] [--force]
  node scripts/scaffold-brand.js --company "Razón social" [--color "#rrggbb"] [--logo archivo.png]

El JSON mínimo es { "companyName": "..." }. El resto se completa con defaults de MSS.
No ejecutes esto sobre la instalación de Bacar salvo que quieras cambiarle la marca.
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

const copyLogo = (source, brand, dryRun) => {
  if (!source) return null;
  if (!fs.existsSync(source)) {
    throw new Error(`No existe el archivo de logo: ${source}`);
  }
  const destName = path.basename(brand.logoPath);
  const dest = path.join(publicDir, destName);
  if (!dryRun) fs.copyFileSync(source, dest);
  return dest;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  let input = {};
  if (args.from) input = loadFromFile(args.from);
  if (args.company) input.companyName = args.company;
  if (args.color) input.primaryColor = args.color;
  if (args.logo) input.logoFile = args.logo;
  if (args.title) input.appTitle = args.title;
  if (args.origin) input.publicOrigin = args.origin;

  const brand = buildBrandConfig(input);
  const source = renderBrandModule(brand);
  const logoSource = resolveLogoSource(input);

  if (args.dryRun) {
    process.stdout.write(`${source}\n`);
    if (logoSource) process.stdout.write(`# copiaría logo ${logoSource} → public${brand.logoPath}\n`);
    process.stdout.write(`# escribiría ${brandJsPath}\n`);
    return;
  }

  if (fs.existsSync(brandJsPath) && !args.force) {
    const current = fs.readFileSync(brandJsPath, 'utf8');
    if (current.includes("companyName: 'Manager Sistem Security'") && !args.from && !args.company) {
      throw new Error('Refusó pisar la marca actual. Pasá --from o --company (y --force si hace falta).');
    }
  }

  fs.writeFileSync(brandJsPath, source, 'utf8');
  const copied = copyLogo(logoSource, brand, false);
  process.stdout.write(`[scaffold-brand] escrito ${path.relative(frontendRoot, brandJsPath)}\n`);
  if (copied) {
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

module.exports = { parseArgs, resolveLogoSource };
