/**
 * Etiquetas de móviles GPS (patente / nombre). Independiente del proveedor.
 */

const extractPlate = (name = '') => {
  const match = String(name).match(/\b([A-Z]{2,3}\d{3}[A-Z]{2,3}|\d{3}[A-Z]{3}|[A-Z]{3}\d{3})\b/i);
  return match ? match[1].toUpperCase() : null;
};

const extractVehicleLabel = (name = '', plate = null) => {
  let label = String(name || '').trim();
  if (!label) return 'Móvil GPS';

  const plateCandidates = [plate, extractPlate(label)].filter(Boolean);
  plateCandidates.forEach((candidate) => {
    label = label.replace(new RegExp(`\\s*[-–—|/]?\\s*\\b${candidate}\\b`, 'i'), '');
  });

  label = label.replace(/\s+/g, ' ').replace(/^[-–—|/ ]+|[-–—|/ ]+$/g, '').trim();

  return label || String(name).trim() || 'Móvil GPS';
};

module.exports = {
  extractPlate,
  extractVehicleLabel
};
