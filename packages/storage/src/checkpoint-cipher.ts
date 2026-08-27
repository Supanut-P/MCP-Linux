import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'baitonghub-linux-mcp:checkpoint:v1:';
const ALGORITHM = 'aes-256-gcm';
const AAD = Buffer.from('baitonghub-linux-mcp-checkpoint-v1', 'utf8');

export interface CheckpointPayloadCipher {
  encrypt(plainText: string): string;
  decrypt(payload: string): string;
  isEncrypted(payload: string): boolean;
}

export class AesGcmCheckpointCipher implements CheckpointPayloadCipher {
  private readonly key: Buffer;

  public constructor(key: Buffer) {
    if (key.byteLength !== 32) throw new Error('Checkpoint encryption key must be 32 bytes');
    this.key = Buffer.from(key);
  }

  public encrypt(plainText: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + [iv, tag, encrypted].map((value) => value.toString('base64')).join(':');
  }

  public decrypt(payload: string): string {
    if (!this.isEncrypted(payload)) throw new Error('Checkpoint payload is not encrypted');
    const encoded = payload.slice(PREFIX.length).split(':');
    if (encoded.length !== 3) throw new Error('Checkpoint payload has an invalid envelope');
    const [ivText, tagText, cipherText] = encoded;
    if (ivText === undefined || tagText === undefined || cipherText === undefined) throw new Error('Checkpoint payload has an invalid envelope');
    const iv = Buffer.from(ivText, 'base64');
    const tag = Buffer.from(tagText, 'base64');
    const encrypted = Buffer.from(cipherText, 'base64');
    if (iv.byteLength !== 12 || tag.byteLength !== 16) throw new Error('Checkpoint payload has invalid encryption metadata');
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  public isEncrypted(payload: string): boolean {
    return payload.startsWith(PREFIX);
  }
}
