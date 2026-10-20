import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type IObjectStorage,
  type ObjectHead,
  ObjectStorageError,
  type PresignedPost,
  type PresignPostInput,
  type PutObjectInput,
} from './object-storage.interface';

/** Static keys: MinIO only. In AWS the ECS task role signs through the default credential chain. */
export interface StorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3ObjectStorageOptions {
  bucket: string;
  region: string;
  /** Per HTTP call to storage; the SDK retries transient failures within its attempts. */
  timeoutMs: number;
  /** MinIO: the endpoint the process reaches. Unset in AWS. */
  endpoint?: string;
  /**
   * MinIO: the endpoint browsers reach, used to sign presigned URLs (inside docker-compose the
   * api reaches `minio:9000`, a browser `localhost:9000`). Defaults to `endpoint`.
   */
  publicEndpoint?: string;
  credentials?: StorageCredentials;
}

const NOT_FOUND_NAMES = new Set(['NotFound', 'NoSuchKey']);
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * S3 through the AWS SDK v3; MinIO through `endpoint` and path-style addressing. Error messages
 * carry the operation and key only, never credentials or signed URLs.
 */
export class S3ObjectStorage implements IObjectStorage {
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly options: S3ObjectStorageOptions) {
    this.client = this.createClient(options.endpoint);
    this.signer =
      options.publicEndpoint && options.publicEndpoint !== options.endpoint
        ? this.createClient(options.publicEndpoint)
        : this.client;
  }

  async presignPost(input: PresignPostInput): Promise<PresignedPost> {
    const { url, fields } = await createPresignedPost(this.signer, {
      Bucket: this.options.bucket,
      Key: input.key,
      Conditions: [
        ['eq', '$Content-Type', input.contentType],
        ['content-length-range', 1, input.maxBytes],
      ],
      Fields: { 'Content-Type': input.contentType },
      Expires: input.expiresInSeconds,
    });
    return { url, fields };
  }

  presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return { sizeBytes: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
    } catch (error) {
      const mapped = this.toError('head', key, error);
      if (mapped.kind === 'not_found') return null;
      throw mapped;
    }
  }

  getRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    return this.read(key, `bytes=${start}-${endInclusive}`);
  }

  get(key: string): Promise<Buffer> {
    return this.read(key);
  }

  async put(input: PutObjectInput): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          CacheControl: input.cacheControl,
        }),
      );
    } catch (error) {
      throw this.toError('put', input.key, error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
    } catch (error) {
      throw this.toError('delete', key, error);
    }
  }

  async ping(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
    } catch (error) {
      throw this.toError('ping', this.options.bucket, error);
    }
  }

  /** Releases the HTTP agents (graceful shutdown). */
  close(): void {
    this.client.destroy();
    if (this.signer !== this.client) this.signer.destroy();
  }

  private async read(key: string, range?: string): Promise<Buffer> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key, Range: range }),
      );
      if (!out.Body) return Buffer.alloc(0);
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (error) {
      throw this.toError('get', key, error);
    }
  }

  private createClient(endpoint: string | undefined): S3Client {
    return new S3Client({
      region: this.options.region,
      endpoint,
      forcePathStyle: endpoint !== undefined,
      credentials: this.options.credentials,
      requestHandler: { requestTimeout: this.options.timeoutMs, connectionTimeout: this.options.timeoutMs },
    });
  }

  private toError(operation: string, key: string, error: unknown): ObjectStorageError {
    const message = `storage ${operation} failed for ${key}`;
    if (!(error instanceof S3ServiceException)) {
      // Network errors, timeouts and aborts never reach a status.
      return new ObjectStorageError(message, 'unavailable', null, { cause: error });
    }
    const status = error.$metadata.httpStatusCode ?? null;
    if (NOT_FOUND_NAMES.has(error.name) || status === HTTP_NOT_FOUND) {
      return new ObjectStorageError(message, 'not_found', status, { cause: error });
    }
    const transient = status === null || status >= HTTP_SERVER_ERROR || status === HTTP_TOO_MANY_REQUESTS;
    return new ObjectStorageError(message, transient ? 'unavailable' : 'rejected', status, { cause: error });
  }
}
