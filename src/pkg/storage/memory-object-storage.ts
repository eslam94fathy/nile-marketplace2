import {
  type IObjectStorage,
  type ObjectHead,
  ObjectStorageError,
  type PresignedPost,
  type PresignPostInput,
  type PutObjectInput,
} from './object-storage.interface';

interface StoredObject {
  body: Buffer;
  contentType: string;
  cacheControl: string | null;
}

/**
 * In-memory stand-in for unit tests (architecture A-10). Presigned URLs use a `memory://` scheme and
 * can't be fetched; tests place uploads with `put` instead. `setUnavailable` scripts an outage.
 */
export class InMemoryObjectStorage implements IObjectStorage {
  readonly objects = new Map<string, StoredObject>();
  private unavailable = false;

  constructor(private readonly bucket = 'memory') {}

  presignPost(input: PresignPostInput): Promise<PresignedPost> {
    return Promise.resolve({
      url: `memory://${this.bucket}`,
      fields: {
        key: input.key,
        'Content-Type': input.contentType,
        'x-max-bytes': String(input.maxBytes),
        'x-expires-in': String(input.expiresInSeconds),
      },
    });
  }

  presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return Promise.resolve(`memory://${this.bucket}/${key}?expires-in=${expiresInSeconds}`);
  }

  head(key: string): Promise<ObjectHead | null> {
    return this.guard('head', key, () => {
      const object = this.objects.get(key);
      return object ? { sizeBytes: object.body.length, contentType: object.contentType } : null;
    });
  }

  getRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    return this.guard('get', key, () => this.require(key).body.subarray(start, endInclusive + 1));
  }

  get(key: string): Promise<Buffer> {
    return this.guard('get', key, () => this.require(key).body);
  }

  put(input: PutObjectInput): Promise<void> {
    return this.guard('put', input.key, () => {
      this.objects.set(input.key, {
        body: Buffer.from(input.body),
        contentType: input.contentType,
        cacheControl: input.cacheControl ?? null,
      });
    });
  }

  delete(key: string): Promise<void> {
    return this.guard('delete', key, () => {
      this.objects.delete(key);
    });
  }

  ping(): Promise<void> {
    return this.guard('ping', this.bucket, () => undefined);
  }

  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  private require(key: string): StoredObject {
    const object = this.objects.get(key);
    if (!object) throw new ObjectStorageError(`storage get failed for ${key}`, 'not_found', 404);
    return object;
  }

  private guard<T>(operation: string, key: string, fn: () => T): Promise<T> {
    if (this.unavailable) {
      return Promise.reject(
        new ObjectStorageError(`storage ${operation} failed for ${key}`, 'unavailable', null),
      );
    }
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
