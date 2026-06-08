import nodemailer, { Transporter } from 'nodemailer';
import { getSmtpConfig, SmtpConfig } from './settings';

export type MailMessage = { to: string; subject: string; html: string; text?: string };

function buildTransporter(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass }
  });
}

export async function isMailerConfigured(): Promise<boolean> {
  const cfg = await getSmtpConfig();
  return cfg !== null;
}

export async function sendMail(msg: MailMessage): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getSmtpConfig();
  if (!cfg) return { ok: false, error: 'SMTP no configurado' };
  try {
    const t = buildTransporter(cfg);
    await t.sendMail({
      from: cfg.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text || msg.html.replace(/<[^>]+>/g, '')
    });
    return { ok: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('sendMail error:', errMsg);
    return { ok: false, error: errMsg };
  }
}

export async function testMailer(toOverride?: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getSmtpConfig();
  if (!cfg) return { ok: false, error: 'SMTP no configurado' };
  try {
    const t = buildTransporter(cfg);
    await t.verify();
    if (toOverride) {
      await t.sendMail({
        from: cfg.from,
        to: toOverride,
        subject: 'Prueba SMTP — Finanzas Mensuales',
        html: '<p>Si recibes este correo, el servidor SMTP está bien configurado. ✅</p>'
      });
    }
    return { ok: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errMsg };
  }
}

export async function getPublicUrl(): Promise<string> {
  const cfg = await getSmtpConfig();
  return cfg?.publicUrl || 'http://204.168.129.129:8088';
}

export function welcomeEmailHtml(params: { name: string; email: string; password: string; loginUrl: string }) {
  const e = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 540px; margin: 0 auto; color: #0f172a">
      <h1 style="color: #047857">Bienvenido a Finanzas Mensuales</h1>
      <p>Hola ${e(params.name)}, tu cuenta ha sido creada por el administrador.</p>
      <p>Estas son tus credenciales:</p>
      <table style="border-collapse: collapse; margin: 16px 0">
        <tr><td style="padding: 6px 12px"><strong>Email</strong></td><td style="padding: 6px 12px; font-family: monospace">${e(params.email)}</td></tr>
        <tr><td style="padding: 6px 12px"><strong>Contraseña</strong></td><td style="padding: 6px 12px; font-family: monospace">${e(params.password)}</td></tr>
      </table>
      <p>Ingresa en: <a href="${e(params.loginUrl)}">${e(params.loginUrl)}</a></p>
      <p style="color: #64748b; font-size: 12px">Te recomendamos cambiar la contraseña la primera vez que ingreses.</p>
    </div>
  `;
}
