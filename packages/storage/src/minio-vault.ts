import * as Minio from 'minio';
import type { Readable } from 'node:stream';

export interface MinioVaultConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

export function loadMinioConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MinioVaultConfig {
  const isProd = env.NODE_ENV === 'production';
  const accessKey = env.S3_ACCESS_KEY;
  const secretKey = env.S3_SECRET_KEY;

  if (isProd && (!accessKey || !secretKey)) {
    throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY must be set in production');
  }

  return {
    endPoint: env.S3_ENDPOINT || 'localhost',
    port: parseInt(env.S3_PORT || '9000', 10),
    useSSL: env.S3_USE_SSL === 'true',
    accessKey: accessKey || 'minio_admin',
    secretKey: secretKey || 'minio_secure_password_123!',
    bucket: env.S3_BUCKET || 'ems-documents',
    region: env.S3_REGION || 'us-east-1',
  };
}

export class MinioVaultClient {
  readonly bucket: string;
  readonly client: Minio.Client;
  private bucketReady = false;

  constructor(private readonly config: MinioVaultConfig) {
    this.bucket = config.bucket;
    this.client = new Minio.Client({
      endPoint: config.endPoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
    });
  }

  /**
   * Ensures the private bucket exists. Never applies an anonymous read policy.
   */
  async ensurePrivateBucket(): Promise<void> {
    if (this.bucketReady) return;
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket, this.config.region || 'us-east-1');
    }
    this.bucketReady = true;
  }

  async putBuffer(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
  ): Promise<void> {
    await this.ensurePrivateBucket();
    await this.client.putObject(
      this.bucket,
      key,
      data,
      data.length,
      metadata ?? { 'Content-Type': 'application/octet-stream' },
    );
  }

  async putStream(
    key: string,
    stream: Readable,
    size?: number,
    metadata?: Record<string, string>,
  ): Promise<void> {
    await this.ensurePrivateBucket();
    await this.client.putObject(
      this.bucket,
      key,
      stream,
      size,
      metadata ?? { 'Content-Type': 'application/octet-stream' },
    );
  }

  async getStream(key: string): Promise<Readable> {
    return this.client.getObject(this.bucket, key);
  }

  async getPartialStream(
    key: string,
    offset: number,
    length: number,
  ): Promise<Readable> {
    return this.client.getPartialObject(this.bucket, key, offset, length);
  }

  async getBuffer(key: string): Promise<Buffer> {
    const stream = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async removeObject(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  async removeObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.removeObjects(this.bucket, keys);
  }

  async statObject(key: string): Promise<{ size: number; etag?: string }> {
    const stat = await this.client.statObject(this.bucket, key);
    return { size: stat.size, etag: stat.etag };
  }
}

