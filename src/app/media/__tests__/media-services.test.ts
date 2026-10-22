import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { type EventEnvelope } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { SharpImageProcessor } from '../../../pkg/image';
import { InMemoryObjectStorage } from '../../../pkg/storage';
import { MediaStatus } from '../enums';
import { type MediaObject } from '../model/media-object.model';
import { type MediaObjectRepository } from '../repository/media-object.repository';
import { MediaProcessingService } from '../service/media-processing.service';
import { MediaUploadService } from '../service/media-upload.service';
import { type MediaUrls } from '../service/media-urls';

const MEDIA_ID = '0192f5e0-0000-7000-8000-0000000000aa';
const OWNER = '0192f5e0-0000-7000-8000-0000000000bb';
const TRX = {} as DbTransaction;

const logger = () => {
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() };
  return { ...log, child: () => log } as unknown as ILogger;
};
const clock: IClock = { now: () => new Date('2026-10-20T10:00:00Z') };

function media(overrides: Partial<MediaObject> = {}): MediaObject {
  return {
    id: MEDIA_ID,
    ownerUserId: OWNER,
    purpose: 'product_image',
    status: MediaStatus.PENDING,
    failureReason: null,
    declaredContentType: 'image/png',
    declaredSizeBytes: 100,
    width: null,
    height: null,
    processedAt: null,
    claimedAt: null,
    releasedAt: null,
    retainedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function repository(row: MediaObject) {
  return {
    findById: vi.fn(() => Promise.resolve(row)),
    markProcessing: vi.fn(() => Promise.resolve(true)),
    markFailed: vi.fn(() => Promise.resolve(true)),
    markReady: vi.fn(() => Promise.resolve(true)),
  };
}

const envelope = { payload: { mediaId: MEDIA_ID } } as unknown as EventEnvelope;

/* Spec 14 UC-ME-2: storage trouble on complete is a 503 that leaves the upload pending. */
describe('MediaUploadService.complete', () => {
  function setup(storage: InMemoryObjectStorage) {
    const repo = repository(media());
    const transactions: ITransactionRunner = { run: (work) => work(TRX) };
    const service = new MediaUploadService(
      repo as unknown as MediaObjectRepository,
      { imageOf: () => Promise.resolve(null) } as unknown as MediaUrls,
      storage,
      transactions,
      { add: vi.fn(), addMany: vi.fn() },
      clock,
      { MEDIA_MAX_UPLOAD_BYTES: 1000, MEDIA_UPLOAD_URL_TTL_SECONDS: 300, MEDIA_MAX_OPEN_UPLOADS_PER_USER: 5 },
      logger(),
    );
    return { service, repo };
  }

  it('storage unreachable → 503 SERVICE_UNAVAILABLE, nothing changes', async () => {
    const storage = new InMemoryObjectStorage();
    storage.setUnavailable(true);
    const { service, repo } = setup(storage);
    await expect(service.complete(OWNER, MEDIA_ID)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      httpStatus: 503,
    });
    expect(repo.markProcessing).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('an object over the size limit → 422 MEDIA_UPLOAD_INVALID and failed', async () => {
    const storage = new InMemoryObjectStorage();
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    await storage.put({
      key: `uploads/${MEDIA_ID}`,
      body: Buffer.concat([png, Buffer.alloc(1000)]),
      contentType: 'image/png',
    });
    const { service, repo } = setup(storage);
    await expect(service.complete(OWNER, MEDIA_ID)).rejects.toMatchObject({ code: 'MEDIA_UPLOAD_INVALID' });
    expect(repo.markFailed).toHaveBeenCalledWith(MEDIA_ID, 'pending', 'unsupported_type');
    expect(storage.objects.has(`uploads/${MEDIA_ID}`)).toBe(false);
  });
});

/* Spec 14 UC-ME-3: private keys and headers; a storage failure retries and records nothing. */
describe('MediaProcessingService', () => {
  function setup(row: MediaObject, storage: InMemoryObjectStorage) {
    const repo = repository(row);
    const service = new MediaProcessingService(
      repo as unknown as MediaObjectRepository,
      storage,
      new SharpImageProcessor(),
      { add: vi.fn(), addMany: vi.fn() },
      clock,
      logger(),
    );
    return { service, repo };
  }
  const png = () =>
    sharp({ create: { width: 800, height: 400, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();

  it('private purposes are written under private/ with no-store caching', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put({ key: `uploads/${MEDIA_ID}`, body: await png(), contentType: 'image/png' });
    const { service } = setup(media({ status: MediaStatus.PROCESSING, purpose: 'return_photo' }), storage);

    const outcome = await service.process(envelope);
    expect(outcome).toMatchObject({ kind: 'ready', width: 800, height: 400 });
    expect([...storage.objects.keys()].filter((key) => !key.startsWith('uploads/')).sort()).toEqual([
      `private/${MEDIA_ID}/large.webp`,
      `private/${MEDIA_ID}/medium.webp`,
      `private/${MEDIA_ID}/thumb.webp`,
    ]);
    expect(storage.objects.get(`private/${MEDIA_ID}/thumb.webp`)).toMatchObject({
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
    });
  });

  it('a storage outage throws (the message is retried) before anything is recorded', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put({ key: `uploads/${MEDIA_ID}`, body: await png(), contentType: 'image/png' });
    storage.setUnavailable(true);
    const { service, repo } = setup(media({ status: MediaStatus.PROCESSING }), storage);
    await expect(service.process(envelope)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(repo.markReady).not.toHaveBeenCalled();
  });

  it('a row that is no longer processing is skipped; a payload without a media id goes to the DLQ', async () => {
    const { service } = setup(media({ status: MediaStatus.READY }), new InMemoryObjectStorage());
    expect(await service.process(envelope)).toEqual({ kind: 'skip' });
    await expect(service.process({ payload: {} } as unknown as EventEnvelope)).rejects.toMatchObject({
      name: 'PermanentEventError',
    });
  });
});
