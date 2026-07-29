/** Comprime una imagen para guardarla como data URL en Firestore (opcional). */

export const MAX_PHOTO_DATA_URL_CHARS = 160000;

/**
 * @param {File|Blob} file
 * @param {{ maxEdge?: number, quality?: number }} [opts]
 * @returns {Promise<string|null>} data:image/jpeg;base64,...
 */
export async function compressImageToDataUrl(file, opts = {}) {
  if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) {
    throw new Error('Seleccioná un archivo de imagen');
  }
  const maxEdge = Number(opts.maxEdge) > 0 ? Number(opts.maxEdge) : 480;
  const quality = Number(opts.quality) > 0 ? Number(opts.quality) : 0.72;

  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo procesar la imagen');
    ctx.drawImage(bitmap, 0, 0, w, h);
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length > MAX_PHOTO_DATA_URL_CHARS) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.55);
    }
    if (dataUrl.length > MAX_PHOTO_DATA_URL_CHARS) {
      throw new Error('La foto es demasiado grande. Probá con otra más chica.');
    }
    return dataUrl;
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

export function isValidPhotoDataUrl(value) {
  const s = String(value || '').trim();
  return s.startsWith('data:image/') && s.length <= MAX_PHOTO_DATA_URL_CHARS;
}
