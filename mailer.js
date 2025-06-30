require('dotenv').config();
const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST;
const port = +process.env.SMTP_PORT || 587;
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

let transporter;
if (host && user && pass) {
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
} else {
  console.warn('SMTP credentials not fully set; emails will be logged to console');
}

module.exports = async function sendMail(opts) {
  const message = {
    from: process.env.FROM_EMAIL || `Draft or Pass <no-reply@draftrpass.com>`,
    ...opts
  };
  if (!transporter) {
    console.log('EMAIL (not sent – missing SMTP config):', message);
    return { simulated: true };
  }
  return transporter.sendMail(message);
}; 