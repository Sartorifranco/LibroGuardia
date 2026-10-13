/** Presets del asistente «¿Qué correo usan?». */
export const MAIL_PRESETS = [
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'smtp.gmail.com',
    port: 587,
    secure: false
  },
  {
    id: 'outlook',
    label: 'Outlook',
    host: 'smtp.office365.com',
    port: 587,
    secure: false
  },
  {
    id: 'otro',
    label: 'Otro',
    host: '',
    port: 587,
    secure: false
  }
];

export const presetById = (id) => MAIL_PRESETS.find((item) => item.id === id) || MAIL_PRESETS[2];
