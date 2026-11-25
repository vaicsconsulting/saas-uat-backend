import fs from 'node:fs/promises';
import path from 'node:path';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { hmac, safeEqual } from '../lib/crypto';

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

/** Screenshot storage. S3 compatible in prod, local disk in dev. */
export interface Storage {
  readonly driver: 'local' | 's3';
  presignUpload(key: string, mimeType: string): Promise<PresignedUpload>;
  viewUrl(key: string): Promise<string>;
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  size(key: string): Promise<number | null>;
}

const ttl = () => config.storage.urlTtlSeconds;

export function signLocal(action: 'up' | 'view', key: string, exp: number): string {
  return hmac(config.jwtSecret, `${action}:${key}:${exp}`);
}

export function verifyLocal(action: 'up' | 'view', key: string, exp: number, sig: string): boolean {
  if (!key || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(signLocal(action, key, exp), sig);
}

export class LocalStorage implements Storage {
  readonly driver = 'local' as const;
  constructor(private dir: string) {}

  private file(key: string): string {
    const clean = key.replace(/\\/g, '/');
    if (clean.includes('..') || path.isAbsolute(clean)) throw new Error('bad key');
    return path.join(path.resolve(this.dir), clean);
  }

  private url(action: 'up' | 'view', key: string): string {
    const exp = Math.floor(Date.now() / 1000) + ttl();
    const q = new URLSearchParams({ key, exp: String(exp), sig: signLocal(action, key, exp) });
    return `${config.publicApiUrl}/files/${action === 'up' ? 'upload' : 'view'}?${q}`;
  }

  async presignUpload(key: string, mimeType: string): Promise<PresignedUpload> {
    return { url: this.url('up', key), method: 'PUT', headers: { 'Content-Type': mimeType } };
  }
  async viewUrl(key: string): Promise<string> {
    return this.url('view', key);
  }
  async put(key: string, body: Buffer): Promise<void> {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, body);
  }
  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.file(key));
  }
  async size(key: string): Promise<number | null> {
    try {
      return (await fs.stat(this.file(key))).size;
    } catch {
      return null;
    }
  }
}

export class S3Storage implements Storage {
  readonly driver = 's3' as const;
  private client: S3Client;
  constructor(private bucket: string) {
    const s = config.storage;
    this.client = new S3Client({
      region: s.region,
      endpoint: s.endpoint,
      forcePathStyle: s.forcePathStyle,
      credentials:
        s.accessKeyId && s.secretAccessKey ? { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } : undefined,
    });
  }
  async presignUpload(key: string, mimeType: string): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mimeType }),
      { expiresIn: ttl() },
    );
    return { url, method: 'PUT', headers: { 'Content-Type': mimeType } };
  }
  async viewUrl(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttl() });
  }
  async put(key: string, body: Buffer, mimeType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mimeType }));
  }
  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await r.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  async size(key: string): Promise<number | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return r.ContentLength ?? 0;
    } catch {
      return null;
    }
  }
}

let instance: Storage | null = null;
export function storage(): Storage {
  if (!instance) {
    instance =
      config.storage.driver === 's3'
        ? new S3Storage(config.storage.bucket)
        : new LocalStorage(config.storage.localDir);
  }
  return instance;
}
export function setStorage(s: Storage): void {
  instance = s;
}
