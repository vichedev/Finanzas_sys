import crypto from 'crypto';
import { globalPrisma as prisma } from './globalPrisma';

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  console.error('FATAL: JWT_SECRET debe estar definido y tener al menos 32 caracteres.');
  process.exit(1);
}

const SECRET_KEYS = new Set(['SMTP_PASS']);

function getEncryptionKey(): Buffer {
  return crypto.createHash('sha256').update(`finanzas-settings:${secret}`).digest();
}

function encrypt(plain: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(stored: string): string {
  if (!stored.startsWith('enc:')) return stored;
  const [, ivB64, tagB64, dataB64] = stored.split(':');
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
  from: string;
  publicUrl: string;
};

export type SmtpConfigPublic = Omit<SmtpConfig, 'pass'> & { hasPass: boolean };

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.globalSetting.findUnique({ where: { key } });
  if (!row) return null;
  return row.isSecret ? decrypt(row.value) : row.value;
}

export async function setSetting(key: string, value: string | null) {
  if (value === null || value === '') {
    await prisma.globalSetting.deleteMany({ where: { key } });
    return;
  }
  const isSecret = SECRET_KEYS.has(key);
  const stored = isSecret ? encrypt(value) : value;
  await prisma.globalSetting.upsert({
    where: { key },
    create: { key, value: stored, isSecret },
    update: { value: stored, isSecret }
  });
}

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const [host, port, user, pass, secure, from, publicUrl] = await Promise.all([
    getSetting('SMTP_HOST'),
    getSetting('SMTP_PORT'),
    getSetting('SMTP_USER'),
    getSetting('SMTP_PASS'),
    getSetting('SMTP_SECURE'),
    getSetting('SMTP_FROM'),
    getSetting('PUBLIC_URL')
  ]);
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(port || 587),
    user,
    pass,
    secure: secure === 'true',
    from: from || user,
    publicUrl: publicUrl || 'http://204.168.129.129:8088'
  };
}

export async function getSmtpConfigPublic(): Promise<SmtpConfigPublic> {
  const [host, port, user, pass, secure, from, publicUrl] = await Promise.all([
    getSetting('SMTP_HOST'),
    getSetting('SMTP_PORT'),
    getSetting('SMTP_USER'),
    getSetting('SMTP_PASS'),
    getSetting('SMTP_SECURE'),
    getSetting('SMTP_FROM'),
    getSetting('PUBLIC_URL')
  ]);
  return {
    host: host || '',
    port: Number(port || 587),
    user: user || '',
    hasPass: Boolean(pass),
    secure: secure === 'true',
    from: from || '',
    publicUrl: publicUrl || ''
  };
}

export async function setSmtpConfig(cfg: Partial<SmtpConfig>) {
  if (cfg.host !== undefined) await setSetting('SMTP_HOST', cfg.host);
  if (cfg.port !== undefined) await setSetting('SMTP_PORT', String(cfg.port));
  if (cfg.user !== undefined) await setSetting('SMTP_USER', cfg.user);
  if (cfg.pass !== undefined && cfg.pass !== '') await setSetting('SMTP_PASS', cfg.pass);
  if (cfg.secure !== undefined) await setSetting('SMTP_SECURE', String(cfg.secure));
  if (cfg.from !== undefined) await setSetting('SMTP_FROM', cfg.from);
  if (cfg.publicUrl !== undefined) await setSetting('PUBLIC_URL', cfg.publicUrl);
}

export async function clearSmtpConfig() {
  await prisma.globalSetting.deleteMany({
    where: { key: { in: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_FROM', 'PUBLIC_URL'] } }
  });
}
