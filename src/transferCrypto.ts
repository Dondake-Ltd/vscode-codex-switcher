import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';

export type EncryptedTransferEnvelope = {
  format: 'codex-account-switcher-profiles-encrypted';
  version: 1;
  exportedAt: string;
  cipher: 'aes-256-gcm';
  kdf: 'pbkdf2-sha256';
  iterations: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

const ENCRYPTED_TRANSFER_FORMAT = 'codex-account-switcher-profiles-encrypted';
const PBKDF2_ITERATIONS = 310000;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

function toBase64(value: Buffer): string {
  return value.toString('base64');
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function deriveKey(passphrase: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(passphrase.normalize('NFKC'), salt, iterations, KEY_LENGTH, 'sha256');
}

export function encryptTransferPayload(payload: unknown, passphrase: string): EncryptedTransferEnvelope {
  const normalizedPassphrase = passphrase.trim();
  if (!normalizedPassphrase) {
    throw new Error('A passphrase is required to encrypt profile exports.');
  }

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(normalizedPassphrase, salt, PBKDF2_ITERATIONS);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    format: ENCRYPTED_TRANSFER_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    cipher: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    tag: toBase64(tag),
    ciphertext: toBase64(ciphertext)
  };
}

export function isEncryptedTransferEnvelope(payload: unknown): payload is EncryptedTransferEnvelope {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }

  const candidate = payload as Partial<EncryptedTransferEnvelope>;
  return candidate.format === ENCRYPTED_TRANSFER_FORMAT && candidate.version === 1;
}

export function decryptTransferPayload(envelope: EncryptedTransferEnvelope, passphrase: string): unknown {
  const normalizedPassphrase = passphrase.trim();
  if (!normalizedPassphrase) {
    throw new Error('A passphrase is required to decrypt this profile export.');
  }

  try {
    const salt = fromBase64(envelope.salt);
    const iv = fromBase64(envelope.iv);
    const tag = fromBase64(envelope.tag);
    const ciphertext = fromBase64(envelope.ciphertext);
    const key = deriveKey(normalizedPassphrase, salt, envelope.iterations);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error('Could not decrypt the profile export. Check the passphrase and try again.');
  }
}
