export interface PresignPostInput {
  key: string;
  /** The exact `Content-Type` the upload must carry. */
  contentType: string;
  /** The upload must be between 1 byte and this size (`content-length-range`). */
  maxBytes: number;
  expiresInSeconds: number;
}

/** A browser-usable presigned POST: send `fields` plus the file as `multipart/form-data` to `url`. */
export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

export interface ObjectHead {
  sizeBytes: number;
  contentType: string | null;
}

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
}

/**
 * `not_found`: the key doesn't exist. `unavailable`: storage couldn't be reached or answered with a
 * server error, so a retry may help. `rejected`: storage refused the request (access, bad input); a
 * retry can't help.
 */
export type ObjectStorageErrorKind = 'not_found' | 'unavailable' | 'rejected';

export class ObjectStorageError extends Error {
  override readonly name = 'ObjectStorageError';

  constructor(
    message: string,
    readonly kind: ObjectStorageErrorKind,
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * One bucket of object storage (S3 in AWS, MinIO locally). Presigning is local: it never calls
 * storage. Every other method may throw `ObjectStorageError`.
 */
export interface IObjectStorage {
  presignPost(input: PresignPostInput): Promise<PresignedPost>;
  /** A GET URL valid for `expiresInSeconds`, for private objects. */
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  /** `null` when the key doesn't exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** Bytes `[start, endInclusive]`, fewer when the object is shorter. */
  getRange(key: string, start: number, endInclusive: number): Promise<Buffer>;
  get(key: string): Promise<Buffer>;
  put(input: PutObjectInput): Promise<void>;
  /** Deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** Readiness: the bucket is reachable with our credentials. */
  ping(): Promise<void>;
}
