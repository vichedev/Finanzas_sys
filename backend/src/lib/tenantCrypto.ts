import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = process.env.TENANT_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('FATAL: TENANT_ENCRYPTION_KEY no está definida. Genera con: openssl rand -hex 32');
  }
  if (hex.length !== 64) {
    throw new Error('FATAL: TENANT_ENCRYPTION_KEY debe ser 64 caracteres hex (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptString(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Formato: iv:tag:data en base64
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptString(token: string): string {
  const key = getKey();
  const parts = token.split(':');
  if (parts.length !== 3) throw new Error('Token cifrado con formato inválido');
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export interface ConnectionPlain { user: string; password: string }
export interface ConnectionCipher { userCipher: string; passwordCipher: string }

export function encryptConnection(plain: ConnectionPlain): ConnectionCipher {
  return {
    userCipher: encryptString(plain.user),
    passwordCipher: encryptString(plain.password)
  };
}

export function decryptConnection(row: { dbUserCipher: string; dbPasswordCipher: string }): ConnectionPlain {
  return {
    user: decryptString(row.dbUserCipher),
    password: decryptString(row.dbPasswordCipher)
  };
}
