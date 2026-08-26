const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extractCompanyName,
  assertCanOverwriteBrand,
  applyScaffoldWrites
} = require('./scaffold-brand');
const { buildBrandConfig, renderBrandModule } = require('./buildBrandConfig');

describe('scaffold-brand guard de overwrite', () => {
  it('lee companyName con comillas simples o dobles', () => {
    assert.equal(
      extractCompanyName("const brand = {\n  companyName: 'Manager Sistem Security',\n}"),
      'Manager Sistem Security'
    );
    assert.equal(
      extractCompanyName('const brand = {\n  companyName: "Acme S.A.",\n}'),
      'Acme S.A.'
    );
  });

  it('exige --force si el companyName actual es otro, también con --from', () => {
    assert.throws(
      () => assertCanOverwriteBrand({
        brandFileExists: true,
        currentCompanyName: 'Manager Sistem Security',
        nextCompanyName: 'Acme Seguridad S.A.',
        force: false
      }),
      /--force/
    );
    assert.doesNotThrow(() => assertCanOverwriteBrand({
      brandFileExists: true,
      currentCompanyName: 'Manager Sistem Security',
      nextCompanyName: 'Acme Seguridad S.A.',
      force: true
    }));
  });

  it('permite reescribir la misma marca sin --force', () => {
    assert.doesNotThrow(() => assertCanOverwriteBrand({
      brandFileExists: true,
      currentCompanyName: 'Acme Seguridad S.A.',
      nextCompanyName: 'Acme Seguridad S.A.',
      force: false
    }));
  });

  it('permite escribir si todavía no hay brand.js', () => {
    assert.doesNotThrow(() => assertCanOverwriteBrand({
      brandFileExists: false,
      currentCompanyName: null,
      nextCompanyName: 'Acme',
      force: false
    }));
  });
});

describe('scaffold-brand escrituras', () => {
  let dir;
  let brandJsPath;
  let publicDir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-brand-'));
    publicDir = path.join(dir, 'public');
    fs.mkdirSync(publicDir);
    brandJsPath = path.join(dir, 'brand.js');
    fs.writeFileSync(
      brandJsPath,
      "const brand = {\n  companyName: 'Manager Sistem Security',\n};\nmodule.exports = brand;\n",
      'utf8'
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--from sin --force no toca brand.js', () => {
    const original = fs.readFileSync(brandJsPath, 'utf8');
    const brand = buildBrandConfig({ companyName: 'Acme Seguridad S.A.' });
    assert.throws(
      () => applyScaffoldWrites({
        brand,
        source: renderBrandModule(brand),
        logoSource: null,
        brandJsPath,
        publicDir,
        force: false
      }),
      /--force/
    );
    assert.equal(fs.readFileSync(brandJsPath, 'utf8'), original);
  });

  it('logo inexistente falla antes de pisar brand.js', () => {
    const original = fs.readFileSync(brandJsPath, 'utf8');
    const brand = buildBrandConfig({
      companyName: 'Acme Seguridad S.A.',
      logoFile: 'faltante.png'
    });
    assert.throws(
      () => applyScaffoldWrites({
        brand,
        source: renderBrandModule(brand),
        logoSource: path.join(dir, 'no-existe.png'),
        brandJsPath,
        publicDir,
        force: true
      }),
      /No existe el archivo de logo/
    );
    assert.equal(fs.readFileSync(brandJsPath, 'utf8'), original);
  });

  it('con --force copia el logo y recién después reemplaza brand.js', () => {
    const logo = path.join(dir, 'acme.png');
    fs.writeFileSync(logo, 'PNG');
    const brand = buildBrandConfig({
      companyName: 'Acme Seguridad S.A.',
      logoFile: 'acme.png'
    });
    applyScaffoldWrites({
      brand,
      source: renderBrandModule(brand),
      logoSource: logo,
      brandJsPath,
      publicDir,
      force: true
    });
    const written = fs.readFileSync(brandJsPath, 'utf8');
    assert.match(written, /Acme Seguridad S\.A\./);
    assert.equal(fs.readFileSync(path.join(publicDir, 'acme.png'), 'utf8'), 'PNG');
    assert.equal(fs.existsSync(`${brandJsPath}.scaffold-new`), false);
  });

  it('si falla la copia de brand.js restaura el logo anterior', () => {
    const existingLogo = path.join(publicDir, 'acme.png');
    fs.writeFileSync(existingLogo, 'VIEJO');
    const logo = path.join(dir, 'acme.png');
    fs.writeFileSync(logo, 'NUEVO');
    const originalBrand = fs.readFileSync(brandJsPath, 'utf8');
    const brand = buildBrandConfig({
      companyName: 'Acme Seguridad S.A.',
      logoFile: 'acme.png'
    });

    const io = {
      existsSync: (...args) => fs.existsSync(...args),
      readFileSync: (...args) => fs.readFileSync(...args),
      copyFileSync: (src, dest) => {
        if (dest === brandJsPath) throw new Error('disco lleno');
        return fs.copyFileSync(src, dest);
      },
      writeFileSync: (...args) => fs.writeFileSync(...args),
      unlinkSync: (...args) => fs.unlinkSync(...args)
    };

    assert.throws(
      () => applyScaffoldWrites({
        brand,
        source: renderBrandModule(brand),
        logoSource: logo,
        brandJsPath,
        publicDir,
        force: true,
        io
      }),
      /disco lleno/
    );
    assert.equal(fs.readFileSync(brandJsPath, 'utf8'), originalBrand);
    assert.equal(fs.readFileSync(existingLogo, 'utf8'), 'VIEJO');
  });
});
