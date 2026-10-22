import { describe, expect, it } from 'vitest';
import { InMemoryObjectStorage, ObjectStorageError } from '..';

/* The unit-test fake keeps the adapter's contract (pkg/storage IObjectStorage, A-10). */
describe('InMemoryObjectStorage', () => {
  it('puts, heads, reads ranges and deletes; a missing key heads null and deletes fine', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put({ key: 'uploads/a', body: Buffer.from('0123456789'), contentType: 'image/png' });

    expect(await storage.head('uploads/a')).toEqual({ sizeBytes: 10, contentType: 'image/png' });
    expect((await storage.getRange('uploads/a', 0, 3)).toString()).toBe('0123');
    expect((await storage.getRange('uploads/a', 8, 20)).toString()).toBe('89');
    expect((await storage.get('uploads/a')).toString()).toBe('0123456789');

    await storage.delete('uploads/a');
    await storage.delete('uploads/a');
    expect(await storage.head('uploads/a')).toBeNull();
    await expect(storage.get('uploads/a')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('presigned URLs carry the key and the conditions without calling storage', async () => {
    const storage = new InMemoryObjectStorage('media');
    storage.setUnavailable(true);
    const post = await storage.presignPost({
      key: 'uploads/b',
      contentType: 'image/jpeg',
      maxBytes: 5,
      expiresInSeconds: 300,
    });
    expect(post).toEqual({
      url: 'memory://media',
      fields: { key: 'uploads/b', 'Content-Type': 'image/jpeg', 'x-max-bytes': '5', 'x-expires-in': '300' },
    });
    expect(await storage.presignGet('private/b', 600)).toBe('memory://media/private/b?expires-in=600');
  });

  it('an outage rejects every storage call as unavailable', async () => {
    const storage = new InMemoryObjectStorage();
    storage.setUnavailable(true);
    for (const call of [storage.ping(), storage.head('k'), storage.delete('k')]) {
      const error: unknown = await call.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ObjectStorageError);
      expect(error).toMatchObject({ kind: 'unavailable' });
    }
  });
});
