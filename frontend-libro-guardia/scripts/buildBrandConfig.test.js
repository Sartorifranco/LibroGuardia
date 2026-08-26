const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  slugify,
  normalizeHex,
  buildBrandConfig,
  renderBrandModule
} = require('./buildBrandConfig');

describe('buildBrandConfig', () => {
  it('exige companyName', () => {
    assert.throws(() => buildBrandConfig({}), /companyName/);
  });

  it('completa textos, hover y themeStorageKey a partir de pocos datos', () => {
    const brand = buildBrandConfig({
      companyName: 'Acme S.A.',
      primaryColor: '1D4ED8',
      publicOrigin: 'https://acme.web.app',
      logoFile: 'C:\\logos\\acme-marca.png'
    });

    assert.equal(brand.companyName, 'Acme S.A.');
    assert.equal(brand.appTitle, 'MSS Guard');
    assert.equal(brand.loginTitle, 'Acme S.A.');
    assert.equal(brand.primaryColor, '#1d4ed8');
    assert.equal(brand.primaryColorHover, '#1840b1');
    assert.equal(brand.logoPath, '/acme-marca.png');
    assert.equal(brand.themeStorageKey, 'acme-s-a-theme');
    assert.equal(brand.publicOrigin, 'https://acme.web.app');
    assert.match(brand.loginSubtitle, /Acme S\.A\./);
    assert.match(brand.pdfReportTitle, /Historial/);
    assert.doesNotMatch(brand.metaDescription, /\.\./);
  });

  it('respeta overrides explícitos y no pisa el hover indicado', () => {
    const brand = buildBrandConfig({
      companyName: 'Norte Seguridad',
      appTitle: 'Norte Guard',
      primaryColor: '#aabbcc',
      primaryColorHover: '#112233',
      themeStorageKey: 'norte-theme',
      logoPath: '/custom-logo.png'
    });
    assert.equal(brand.appTitle, 'Norte Guard');
    assert.equal(brand.primaryColorHover, '#112233');
    assert.equal(brand.themeStorageKey, 'norte-theme');
    assert.equal(brand.logoPath, '/custom-logo.png');
    assert.equal(brand.shortName, 'Norte Guard');
  });

  it('slugify ignora tildes y caracteres raros', () => {
    assert.equal(slugify('Ángel & Cía. 12'), 'angel-cia-12');
    assert.equal(slugify('   '), 'cliente');
  });

  it('normalizeHex acepta con o sin #, y cae al default si es basura', () => {
    assert.equal(normalizeHex('#FF00AA', '#000000'), '#ff00aa');
    assert.equal(normalizeHex('AABBCC', '#000000'), '#aabbcc');
    assert.equal(normalizeHex('rojo', '#e11d2e'), '#e11d2e');
  });

  it('renderBrandModule exporta un módulo CommonJS parseable', () => {
    const brand = buildBrandConfig({ companyName: 'Demo' });
    const source = renderBrandModule(brand);
    assert.match(source, /module\.exports = brand/);
    const module = { exports: {} };
    // eslint-disable-next-line no-new-func
    Function('module', 'exports', source)(module, module.exports);
    assert.equal(module.exports.companyName, 'Demo');
    assert.equal(module.exports.themeStorageKey, 'demo-theme');
  });
});
