import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PresignedPost, S3ObjectStorage } from '../../src/pkg/storage';
import { createTestBucket, type TestBucket } from '../helpers/test-storage';

const MAX_BYTES = 64;

/** What a browser does with a presigned POST: the fields first, the file last. */
function upload(post: PresignedPost, body: Buffer, contentType: string): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(post.fields)) form.append(name, value);
  form.append('file', new Blob([body], { type: contentType }));
  return fetch(post.url, { method: 'POST', body: form });
}

/* pkg/storage S3 adapter against MinIO (architecture §14.9, A-10; spec 14 UC-ME-1, UC-ME-2). */
describe('S3ObjectStorage (MinIO)', () => {
  let bucket: TestBucket;
  let storage: S3ObjectStorage;

  beforeAll(async () => {
    bucket = await createTestBucket();
    storage = new S3ObjectStorage(bucket.options);
  });
  afterAll(async () => {
    storage.close();
    await bucket.cleanup();
  });

  const presign = (key: string, contentType = 'image/png') =>
    storage.presignPost({ key, contentType, maxBytes: MAX_BYTES, expiresInSeconds: 300 });

  it('a presigned POST accepts the exact key and type within the size range', async () => {
    const res = await upload(await presign('uploads/ok'), Buffer.alloc(MAX_BYTES, 1), 'image/png');
    expect(res.status).toBe(204);
    expect(await storage.head('uploads/ok')).toEqual({ sizeBytes: MAX_BYTES, contentType: 'image/png' });
  });

  it('a presigned POST refuses a file over the size limit, an empty file and another content type', async () => {
    const tooLarge = await upload(await presign('uploads/big'), Buffer.alloc(MAX_BYTES + 1), 'image/png');
    expect(tooLarge.status).toBe(400);
    const empty = await upload(await presign('uploads/empty'), Buffer.alloc(0), 'image/png');
    expect(empty.status).toBe(400);

    const post = await presign('uploads/type');
    const wrongType = await upload(
      { ...post, fields: { ...post.fields, 'Content-Type': 'text/html' } },
      Buffer.from('<script>'),
      'text/html',
    );
    expect(wrongType.status).toBe(403);
    for (const key of ['uploads/big', 'uploads/empty', 'uploads/type'])
      expect(await storage.head(key)).toBeNull();
  });

  it('a presigned POST refuses another key', async () => {
    const post = await presign('uploads/mine');
    const res = await upload(
      { ...post, fields: { ...post.fields, key: 'public/theirs' } },
      Buffer.from('x'),
      'image/png',
    );
    expect(res.status).toBe(403);
    expect(await storage.head('public/theirs')).toBeNull();
  });

  it('puts, reads a byte range and the whole object, serves a presigned GET, deletes', async () => {
    await storage.put({
      key: 'private/doc',
      body: Buffer.from('0123456789'),
      contentType: 'image/webp',
      cacheControl: 'private, max-age=60',
    });
    expect((await storage.getRange('private/doc', 0, 3)).toString()).toBe('0123');
    expect((await storage.getRange('private/doc', 8, 100)).toString()).toBe('89');
    expect((await storage.get('private/doc')).toString()).toBe('0123456789');

    const url = await storage.presignGet('private/doc', 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(await res.text()).toBe('0123456789');
    // Unsigned, the same object is refused.
    expect((await fetch(url.split('?')[0] ?? url)).status).toBe(403);

    await storage.delete('private/doc');
    await storage.delete('private/doc');
    expect(await storage.head('private/doc')).toBeNull();
  });

  it('a missing key: head → null, get → not_found', async () => {
    expect(await storage.head('uploads/none')).toBeNull();
    await expect(storage.get('uploads/none')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('ping succeeds on the bucket; a missing bucket or unreachable storage fails', async () => {
    await storage.ping();

    const missing = new S3ObjectStorage({ ...bucket.options, bucket: 'no-such-bucket' });
    await expect(missing.ping()).rejects.toMatchObject({ name: 'ObjectStorageError', kind: 'not_found' });
    missing.close();

    // A closed local port: refused at once, no status → unavailable.
    const down = new S3ObjectStorage({ ...bucket.options, endpoint: 'http://127.0.0.1:1', timeoutMs: 500 });
    await expect(down.head('uploads/ok')).rejects.toMatchObject({ kind: 'unavailable', status: null });
    down.close();
  });

  it('presigned URLs signed for a public endpoint point there (docker-compose: localhost vs minio)', async () => {
    const endpoint = bucket.options.endpoint ?? '';
    const publicEndpoint = endpoint.replace('localhost', '127.0.0.1');
    const signer = new S3ObjectStorage({ ...bucket.options, publicEndpoint });
    const post = await signer.presignPost({
      key: 'uploads/public',
      contentType: 'image/png',
      maxBytes: MAX_BYTES,
      expiresInSeconds: 300,
    });
    expect(post.url.startsWith(publicEndpoint)).toBe(true);
    expect((await upload(post, Buffer.from('x'), 'image/png')).status).toBe(204);
    expect(await fetch(await signer.presignGet('uploads/public', 60)).then((res) => res.status)).toBe(200);
    signer.close();
  });
});
