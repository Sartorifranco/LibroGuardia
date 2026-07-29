/**
 * Normaliza foto opcional (data URL) para Firestore.
 * Límite ~160k chars para no inflar documentos.
 */

const MAX_PHOTO_CHARS = 160000;

const normalizePhotoDataUrl = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!s.startsWith('data:image/')) {
    return { ok: false, message: 'La foto debe ser una imagen válida' };
  }
  if (s.length > MAX_PHOTO_CHARS) {
    return { ok: false, message: 'La foto es demasiado grande. Usá una imagen más chica.' };
  }
  return { ok: true, value: s };
};

module.exports = {
  MAX_PHOTO_CHARS,
  normalizePhotoDataUrl
};
