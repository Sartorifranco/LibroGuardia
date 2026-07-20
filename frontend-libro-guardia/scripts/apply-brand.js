/**
 * Regenera public/index.html y public/manifest.json desde src/config/brand.js.
 * Se ejecuta en prestart / prebuild / pretest.
 */
const fs = require('fs');
const path = require('path');

const brand = require('../src/config/brand');

const publicDir = path.join(__dirname, '..', 'public');

const indexHtml = `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="%PUBLIC_URL%/favicon.ico" sizes="any" />
    <link rel="icon" type="image/png" sizes="32x32" href="%PUBLIC_URL%/favicon-32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="%PUBLIC_URL%/favicon-16.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="${brand.primaryColor}" />
    <meta
      name="description"
      content="${brand.metaDescription.replace(/"/g, '&quot;')}"
    />
    <link rel="apple-touch-icon" href="%PUBLIC_URL%/favicon-512.png" />
    <link rel="manifest" href="%PUBLIC_URL%/manifest.json" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <script>
      (function () {
        var theme = localStorage.getItem('${brand.themeStorageKey}') || 'dark';
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.style.colorScheme = theme;
      })();
    </script>
    <title>${brand.appTitle}</title>
  </head>
  <body>
    <noscript>Necesitas habilitar JavaScript para ejecutar esta aplicación.</noscript>
    <div id="root"></div>
  </body>
</html>
`;

const manifest = {
  short_name: brand.shortName,
  name: `${brand.appTitle} ${brand.companyName}`.trim(),
  icons: [
    {
      src: 'favicon-512.png',
      type: 'image/png',
      sizes: '512x512'
    },
    {
      src: 'favicon-32.png',
      type: 'image/png',
      sizes: '32x32'
    }
  ],
  start_url: '.',
  display: 'standalone',
  theme_color: brand.primaryColor,
  background_color: brand.backgroundColor
};

fs.writeFileSync(path.join(publicDir, 'index.html'), indexHtml, 'utf8');
fs.writeFileSync(
  path.join(publicDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
);

console.log('[apply-brand] index.html y manifest.json actualizados desde src/config/brand.js');
