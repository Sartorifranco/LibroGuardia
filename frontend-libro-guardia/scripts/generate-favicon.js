const fs = require('fs');
const path = require('path');

async function main() {
  const sharp = require('sharp');
  const pngToIco = (await import('png-to-ico')).default;

  const publicDir = path.join(__dirname, '..', 'public');
  const source = path.join(publicDir, 'B roja.png');
  const square512 = path.join(publicDir, 'favicon-512.png');
  const square32 = path.join(publicDir, 'favicon-32.png');
  const square16 = path.join(publicDir, 'favicon-16.png');
  const icoOut = path.join(publicDir, 'favicon.ico');

  const makeSquare = (size, out) =>
    sharp(source)
      .resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(out);

  await makeSquare(512, square512);
  await makeSquare(32, square32);
  await makeSquare(16, square16);

  const icoBuffer = await pngToIco([square16, square32, square512]);
  fs.writeFileSync(icoOut, icoBuffer);

  console.log('Favicons generados en public/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
