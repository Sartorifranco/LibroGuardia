export const MAX_PLAN_SIDE = 2400;
export const MAX_PLAN_BYTES = 900 * 1024;
export const MIN_PLAN_SIDE = 100;
export const TOO_HEAVY_MESSAGE = 'La imagen es muy pesada. Probá con una más chica o recortada.';

const QUALITY_STEPS = [0.82, 0.74, 0.66, 0.58, 0.5];

export const dataUrlBytes = (dataUrl = '') => {
  const b64 = String(dataUrl).split(',')[1] || '';
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
};

export const fitSize = (width, height, max = MAX_PLAN_SIDE) => {
  const ratio = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
};

const loadImage = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    resolve(img);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    reject(new Error('No se pudo abrir la imagen. Probá con un JPG o PNG.'));
  };
  img.src = url;
});

/** Escala a 2400 px como máximo y la pasa a WebP; baja la calidad hasta que entre en 900 KB. */
export async function compressPlanImage(file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    throw new Error('Elegí un archivo de imagen (JPG, PNG o WebP).');
  }
  const img = await loadImage(file);
  const { width, height } = fitSize(img.naturalWidth || img.width, img.naturalHeight || img.height);
  if (width < MIN_PLAN_SIDE || height < MIN_PLAN_SIDE) {
    throw new Error('La imagen es muy chica. Usá una de al menos 100 px de lado.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  for (const quality of QUALITY_STEPS) {
    let dataUrl = canvas.toDataURL('image/webp', quality);
    // Navegadores sin WebP devuelven PNG: usar JPEG, que también comprime.
    if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrlBytes(dataUrl) <= MAX_PLAN_BYTES) return { imageDataUrl: dataUrl, width, height };
  }
  throw new Error(TOO_HEAVY_MESSAGE);
}
