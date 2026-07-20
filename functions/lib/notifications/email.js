/**
 * Canal email (SMTP vía nodemailer).
 * Misma interfaz que futuros canales: sendNotification(message, channelConfig).
 */

const nodemailer = require('nodemailer');

const id = 'email';

const buildTransport = (smtp = {}) => {
  if (!smtp.host) {
    throw new Error('SMTP sin host configurado');
  }
  return nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port) || 587,
    secure: smtp.secure === true,
    auth: smtp.user
      ? {
        user: smtp.user,
        pass: smtp.password || ''
      }
      : undefined
  });
};

/**
 * @param {{ to: string[], subject: string, text: string, html?: string }} message
 * @param {{ smtp: object }} channelConfig
 */
const sendNotification = async (message, channelConfig = {}) => {
  const recipients = Array.isArray(message.to) ? message.to.filter(Boolean) : [];
  if (!recipients.length) {
    return { sent: false, skipped: true, reason: 'sin_destinatarios' };
  }

  const smtp = channelConfig.smtp || {};
  if (!smtp.host || !smtp.from) {
    return { sent: false, skipped: true, reason: 'smtp_incompleto' };
  }

  const transport = buildTransport(smtp);
  const info = await transport.sendMail({
    from: smtp.from,
    to: recipients.join(', '),
    subject: message.subject || 'LibroGuardia — alerta',
    text: message.text || '',
    html: message.html || undefined
  });

  return {
    sent: true,
    via: 'email',
    messageId: info.messageId || null,
    accepted: info.accepted || recipients
  };
};

module.exports = {
  id,
  sendNotification,
  buildTransport
};
