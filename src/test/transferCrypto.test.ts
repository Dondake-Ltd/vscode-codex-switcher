import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptTransferPayload,
  encryptTransferPayload,
  isEncryptedTransferEnvelope
} from '../transferCrypto';

test('encryptTransferPayload creates an encrypted envelope that decrypts back to the original payload', () => {
  const payload = {
    format: 'codex-account-switcher-profiles',
    version: 1,
    profiles: [{ name: 'Example', email: 'user@example.com' }]
  };

  const encrypted = encryptTransferPayload(payload, 'correct horse battery staple');
  assert.equal(encrypted.format, 'codex-account-switcher-profiles-encrypted');
  assert.equal(encrypted.version, 1);
  assert.ok(isEncryptedTransferEnvelope(encrypted));

  const decrypted = decryptTransferPayload(encrypted, 'correct horse battery staple');
  assert.deepEqual(decrypted, payload);
});

test('decryptTransferPayload rejects an incorrect passphrase', () => {
  const encrypted = encryptTransferPayload({ hello: 'world' }, 'hunter2!!');
  assert.throws(
    () => decryptTransferPayload(encrypted, 'wrong passphrase'),
    /Could not decrypt the profile export/
  );
});
