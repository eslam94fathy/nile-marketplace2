import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMediaJobs, type MediaService } from '../../src/app/media';
import { type MediaDto } from '../../src/app/media/dto/media-response.dto';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { TOKENS } from '../../src/lib/di';
import { type AppError } from '../../src/lib/error';
import { EventConsumerHost, OutboxDrainer } from '../../src/lib/events';
import { type JobDefinition } from '../../src/lib/jobs';
import { AmqpProbe, waitFor } from '../helpers/amqp-probe';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { jpegWithGps, mediaApi, postToStorage, testImage } from '../helpers/media';
import { createMemoryLogger, type MemoryLogWriter } from '../helpers/memory-logger';
import { sellerFixtures } from '../helpers/sellers';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';
const MAX_OPEN_UPLOADS = 3;

interface MediaRow {
  status: string;
  failure_reason: string | null;
  claimed_at: Date | null;
  released_at: Date | null;
  retained_at: Date | null;
}

/*
 * Spec 14 end to end on real Postgres, RabbitMQ and MinIO: presign → browser-style upload → complete →
 * outbox → media.processing consumer (sharp) → ready, plus the public API and the cleanup job.
 */
describe('media', () => {
  let t: TestApp;
  let fx: ReturnType<typeof sellerFixtures>;
  let worker: WorkerInfrastructure;
  let workerLogs: MemoryLogWriter;
  let drainer: OutboxDrainer;
  let probe: AmqpProbe;
  let cleanup: JobDefinition;
  let mediaService: MediaService;

  const knex = () => t.infra.db.knex;
  const row = (id: string) =>
    knex()('media_objects')
      .where({ id })
      .first<MediaRow | undefined>('status', 'failure_reason', 'claimed_at', 'released_at', 'retained_at');
  const objectExists = async (key: string) => (await t.infra.objectStorage.head(key)) !== null;
  const outboxTypes = async (mediaId: string) =>
    (
      await knex()('events_outbox')
        .where({ aggregate_id: mediaId })
        .orderBy('id')
        .select<{ event_type: string }[]>('event_type')
    ).map((event) => event.event_type);
  const age = (id: string, hours: number) =>
    knex().raw(`UPDATE media_objects SET created_at = now() - make_interval(hours => ?) WHERE id = ?`, [
      hours,
      id,
    ]);

  /** Drains the outbox until the media leaves `processing`. */
  async function processed(api: ReturnType<typeof mediaApi>, mediaId: string): Promise<MediaDto> {
    await drainer.drainOnce();
    let media: MediaDto | undefined;
    await waitFor(async () => {
      media = await api.media(mediaId);
      return media.status !== 'processing';
    }, 20_000);
    if (!media) throw new Error('unreachable');
    return media;
  }

  const seller = async () => mediaApi(t, (await fx.createVerifiedSeller()).accessToken);
  const customer = async () => {
    const created = await fx.createActiveCustomer();
    return { ...created, api: mediaApi(t, created.accessToken) };
  };

  beforeAll(async () => {
    t = await startTestApp({
      envOverrides: {
        RATE_LIMIT_STRICT_AUTH_POINTS: '10000',
        MEDIA_MAX_OPEN_UPLOADS_PER_USER: String(MAX_OPEN_UPLOADS),
      },
    });
    fx = sellerFixtures(t);
    mediaService = t.container.resolve<MediaService>(TOKENS.MediaService);

    const { logger, writer } = createMemoryLogger();
    workerLogs = writer;
    // Same database, vhost and bucket as the api: a worker next to it.
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    const container = createWorkerContainer(worker);
    await worker.broker.assertExchange(worker.env.RABBITMQ_EXCHANGE);
    const consumers = new EventConsumerHost(worker.broker, worker.db, logger, worker.env);
    for (const handler of createEventHandlers(container)) await consumers.start(handler);
    drainer = new OutboxDrainer(worker.db.knex, worker.broker, worker.clock, logger, {
      exchange: worker.env.RABBITMQ_EXCHANGE,
      batchSize: worker.env.OUTBOX_BATCH_SIZE,
      maxBackoffMs: worker.env.OUTBOX_MAX_BACKOFF_MS,
    });
    probe = await AmqpProbe.open(t.resources.workerEnv.RABBITMQ_URL);
    const [job] = createMediaJobs(container, worker.env);
    if (!job) throw new Error('no media cleanup job');
    cleanup = job;
  });
  afterAll(async () => {
    await probe.close();
    await closeInfrastructure(worker);
    await t.close();
  });

  describe('upload → process → ready', () => {
    it('a seller image is resized to three public WebP sizes without EXIF; the original is deleted', async () => {
      const api = await seller();
      const { ticket, completed } = await api.upload(
        'product_image',
        await jpegWithGps(1600, 900),
        'image/jpeg',
      );
      expect(ticket.media).toMatchObject({ purpose: 'product_image', status: 'pending', image: null });
      expect(new Date(ticket.upload.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(completed.status).toBe(202);
      expect(successBody<MediaDto>(completed).data.status).toBe('processing');

      const media = await processed(api, ticket.media.id);
      expect(media).toMatchObject({ status: 'ready', failureReason: null });
      expect(media.image).toMatchObject({ id: media.id, width: 1200, height: 675 });
      const base = t.resources.env.MEDIA_PUBLIC_BASE_URL;
      expect(media.image?.urls).toEqual({
        thumb: `${base}/public/${media.id}/thumb.webp`,
        medium: `${base}/public/${media.id}/medium.webp`,
        large: `${base}/public/${media.id}/large.webp`,
      });

      // Public: readable without signing, as through the CDN.
      const res = await fetch(media.image?.urls.large ?? '');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      const bytes = Buffer.from(await res.arrayBuffer());
      const metadata = await sharp(bytes).metadata();
      expect({ format: metadata.format, width: metadata.width, exif: metadata.exif }).toEqual({
        format: 'webp',
        width: 1200,
        exif: undefined,
      });
      expect(bytes.includes(Buffer.from('PhoneCo'))).toBe(false);
      const thumb = await sharp(
        Buffer.from(await (await fetch(media.image?.urls.thumb ?? '')).arrayBuffer()),
      ).metadata();
      expect([thumb.width, thumb.height]).toEqual([200, 113]);

      await waitFor(async () => !(await objectExists(`uploads/${media.id}`)));
      expect(await outboxTypes(media.id)).toEqual(['media.uploaded', 'media.ready']);
      // A retried complete answers with the current state.
      const again = await api.complete(media.id);
      expect(again.status).toBe(200);
      expect(successBody<MediaDto>(again).data.status).toBe('ready');
    });

    it('private media (support attachment) is served by presigned URLs only', async () => {
      const { api } = await customer();
      const { ticket } = await api.upload(
        'support_attachment',
        await testImage(400, 400, 'png'),
        'image/png',
      );
      const media = await processed(api, ticket.media.id);
      const url = media.image?.urls.medium ?? '';
      expect(url).toContain(`/private/${media.id}/medium.webp`);
      expect(url).toContain('X-Amz-Signature=');
      expect((await fetch(url)).status).toBe(200);
      expect((await fetch(url.split('?')[0] ?? url)).status).toBe(403);
    });

    it('a redelivered or repeated media.uploaded for a ready image changes nothing', async () => {
      const api = await seller();
      const { ticket } = await api.upload('product_image', await testImage(300, 300, 'webp'), 'image/webp');
      await processed(api, ticket.media.id);
      const envelope = {
        eventId: randomUUID(),
        eventType: 'media.uploaded',
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: null,
        aggregateType: 'media_object',
        aggregateId: ticket.media.id,
        payload: { mediaId: ticket.media.id, purpose: 'product_image', ownerUserId: randomUUID() },
      };
      for (let i = 0; i < 2; i += 1) {
        probe.channel.publish(
          worker.env.RABBITMQ_EXCHANGE,
          'media.uploaded',
          Buffer.from(JSON.stringify(envelope)),
        );
      }
      await waitFor(
        async () =>
          (
            await knex()('processed_events').where({
              consumer: 'media.processing',
              event_id: envelope.eventId,
            })
          ).length === 1,
      );
      expect((await api.media(ticket.media.id)).status).toBe('ready');
      expect(await outboxTypes(ticket.media.id)).toEqual(['media.uploaded', 'media.ready']);
    });
  });

  describe('failures', () => {
    it('content not matching the declared type → 422 MEDIA_UPLOAD_INVALID, failed, object deleted; complete again → 409', async () => {
      const api = await seller();
      const res = await api.requestUpload({
        purpose: 'product_image',
        contentType: 'image/png',
        sizeBytes: 5000,
      });
      const ticket = successBody<{
        media: MediaDto;
        upload: { url: string; fields: Record<string, string>; expiresAt: string };
      }>(res).data;
      expect(
        (await postToStorage(ticket.upload, await testImage(300, 300, 'jpeg'), 'image/png')).status,
      ).toBe(204);

      const completed = await api.complete(ticket.media.id);
      expect(completed.status).toBe(422);
      expect(errorBody(completed).error.code).toBe('MEDIA_UPLOAD_INVALID');
      expect(await row(ticket.media.id)).toMatchObject({
        status: 'failed',
        failure_reason: 'unsupported_type',
      });
      expect(await objectExists(`uploads/${ticket.media.id}`)).toBe(false);

      const again = await api.complete(ticket.media.id);
      expect(again.status).toBe(409);
      expect(errorBody(again).error.code).toBe('MEDIA_INVALID_STATUS');
    });

    it('complete before the file reached storage → 409 MEDIA_UPLOAD_MISSING (still pending)', async () => {
      const api = await seller();
      const res = await api.requestUpload({
        purpose: 'product_image',
        contentType: 'image/jpeg',
        sizeBytes: 1000,
      });
      const { media } = successBody<{ media: MediaDto }>(res).data;
      const completed = await api.complete(media.id);
      expect(completed.status).toBe(409);
      expect(errorBody(completed).error.code).toBe('MEDIA_UPLOAD_MISSING');
      expect((await row(media.id))?.status).toBe('pending');
    });

    it('bytes that are not a decodable image → failed decode_failed + media.failed; too small → dimensions_out_of_range', async () => {
      const api = await seller();
      const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
      const first = await api.upload('product_image', corrupt, 'image/jpeg');
      expect(first.completed.status).toBe(202);
      expect(await processed(api, first.ticket.media.id)).toMatchObject({
        status: 'failed',
        failureReason: 'decode_failed',
        image: null,
      });
      expect(await outboxTypes(first.ticket.media.id)).toEqual(['media.uploaded', 'media.failed']);
      await waitFor(async () => !(await objectExists(`uploads/${first.ticket.media.id}`)));

      const small = await api.upload('product_image', await testImage(150, 600, 'png'), 'image/png');
      expect(await processed(api, small.ticket.media.id)).toMatchObject({
        status: 'failed',
        failureReason: 'dimensions_out_of_range',
      });
    });

    it('an object replaced after complete is checked again by the worker → unsupported_type (ME-7)', async () => {
      const api = await seller();
      const { ticket, completed } = await api.upload(
        'product_image',
        await testImage(300, 300, 'png'),
        'image/png',
      );
      expect(completed.status).toBe(202);
      // The presigned form is still valid: the same key, the same declared type, other bytes.
      expect(
        (
          await postToStorage(
            ticket.upload,
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
            'image/png',
          )
        ).status,
      ).toBe(204);
      expect(await processed(api, ticket.media.id)).toMatchObject({
        status: 'failed',
        failureReason: 'unsupported_type',
      });
    });
  });

  describe('POST /media/uploads', () => {
    it('validation: unknown purpose or type, size 0 or over the limit, unknown key → 400', async () => {
      const api = await seller();
      const max = t.resources.env.MEDIA_MAX_UPLOAD_BYTES;
      for (const body of [
        { purpose: 'avatar', contentType: 'image/jpeg', sizeBytes: 10 },
        { purpose: 'product_image', contentType: 'image/gif', sizeBytes: 10 },
        { purpose: 'product_image', contentType: 'image/jpeg', sizeBytes: 0 },
        { purpose: 'product_image', contentType: 'image/jpeg', sizeBytes: max + 1 },
        { purpose: 'product_image', contentType: 'image/jpeg', sizeBytes: '10' },
        { purpose: 'product_image', contentType: 'image/jpeg', sizeBytes: 10, key: 'public/x' },
      ]) {
        const res = await api.requestUpload(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(errorBody(res).error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('the role must match the purpose → 403 MEDIA_PURPOSE_NOT_ALLOWED; delivery agents → 403; no token → 401', async () => {
      const { api } = await customer();
      const res = await api.requestUpload({
        purpose: 'product_image',
        contentType: 'image/jpeg',
        sizeBytes: 10,
      });
      expect(res.status).toBe(403);
      expect(errorBody(res).error.code).toBe('MEDIA_PURPOSE_NOT_ALLOWED');
      const agent = mediaApi(t, await signTestAccessToken({ role: 'delivery_agent' }));
      const agentRes = await agent.requestUpload({
        purpose: 'support_attachment',
        contentType: 'image/jpeg',
        sizeBytes: 10,
      });
      expect(agentRes.status).toBe(403);
      expect(errorBody(agentRes).error.code).toBe('FORBIDDEN');
      expect((await request(t.app).post(`${API}/media/uploads`).send({})).status).toBe(401);
    });

    it('at the open-upload limit → 422 MEDIA_OPEN_UPLOAD_LIMIT_REACHED', async () => {
      const api = await seller();
      const body = { purpose: 'product_image', contentType: 'image/jpeg', sizeBytes: 10 };
      for (let i = 0; i < MAX_OPEN_UPLOADS; i += 1) expect((await api.requestUpload(body)).status).toBe(201);
      const res = await api.requestUpload(body);
      expect(res.status).toBe(422);
      expect(errorBody(res).error.code).toBe('MEDIA_OPEN_UPLOAD_LIMIT_REACHED');
    });
  });

  describe('GET /media/:mediaId and complete: the uploader only', () => {
    it("another user's media, an unknown id → 404 MEDIA_NOT_FOUND; a bad id → 400", async () => {
      const owner = await seller();
      const res = await owner.requestUpload({
        purpose: 'product_image',
        contentType: 'image/jpeg',
        sizeBytes: 10,
      });
      const { media } = successBody<{ media: MediaDto }>(res).data;
      const other = await seller();
      for (const call of [other.get(media.id), other.complete(media.id), owner.get(UNKNOWN_ID)]) {
        const answer = await call;
        expect(answer.status).toBe(404);
        expect(errorBody(answer).error.code).toBe('MEDIA_NOT_FOUND');
      }
      expect((await owner.get('not-a-uuid')).status).toBe(400);
      expect((await owner.get(media.id)).status).toBe(200);
    });
  });

  describe('public API: claim, release, getImages', () => {
    async function readyImage(api: ReturnType<typeof mediaApi>, purpose = 'product_image') {
      const { ticket } = await api.upload(purpose, await testImage(300, 300, 'png'), 'image/png');
      return processed(api, ticket.media.id);
    }
    const claimError = async (
      ids: string[],
      purpose: 'product_image' | 'category_image',
      ownerUserId: string,
    ) => {
      const error: unknown = await t.infra.db
        .run((trx) => mediaService.claim(ids, { purpose, ownerUserId }, trx))
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      return error as AppError | null;
    };

    it('claims only ready, own, unclaimed media of the purpose; one detail per bad id, nothing claimed', async () => {
      const owner = await fx.createVerifiedSeller();
      const api = mediaApi(t, owner.accessToken);
      const ready = await readyImage(api);
      const pending = successBody<{ media: MediaDto }>(
        await api.requestUpload({ purpose: 'product_image', contentType: 'image/png', sizeBytes: 10 }),
      ).data.media;
      const theirs = await readyImage(await seller());

      const error = await claimError(
        [ready.id, pending.id, theirs.id, UNKNOWN_ID, ready.id],
        'product_image',
        owner.userId,
      );
      expect(error?.code).toBe('MEDIA_NOT_ATTACHABLE');
      expect(error?.details?.map((d) => [d.field, d.constraint])).toEqual([
        ['mediaIds[1]', 'not_ready'],
        ['mediaIds[2]', 'not_found'],
        ['mediaIds[3]', 'not_found'],
        ['mediaIds[4]', 'duplicate'],
      ]);
      expect((await row(ready.id))?.claimed_at).toBeNull();
      expect((await claimError([ready.id], 'category_image', owner.userId))?.details?.[0]?.constraint).toBe(
        'wrong_purpose',
      );

      expect(await claimError([ready.id], 'product_image', owner.userId)).toBeNull();
      expect((await row(ready.id))?.claimed_at).not.toBeNull();
      expect((await claimError([ready.id], 'product_image', owner.userId))?.details?.[0]?.constraint).toBe(
        'already_claimed',
      );

      const images = await mediaService.getImages([ready.id, pending.id, UNKNOWN_ID]);
      expect([...images.keys()]).toEqual([ready.id]);
      expect(images.get(ready.id)).toEqual(ready.image);
    });

    it("any admin may claim another admin's category image (ME-2)", async () => {
      const first = await fx.createActiveAdmin();
      const second = await fx.createActiveAdmin();
      const image = await readyImage(mediaApi(t, first.session.accessToken), 'category_image');
      expect(await claimError([image.id], 'category_image', second.userId)).toBeNull();
    });

    it('release marks claimed media only', async () => {
      const owner = await fx.createVerifiedSeller();
      const image = await readyImage(mediaApi(t, owner.accessToken));
      await t.infra.db.run((trx) => mediaService.release([image.id], trx));
      expect((await row(image.id))?.released_at).toBeNull();
      await t.infra.db.run((trx) =>
        mediaService.claim([image.id], { purpose: 'product_image', ownerUserId: owner.userId }, trx),
      );
      await t.infra.db.run((trx) => mediaService.release([image.id], trx));
      expect((await row(image.id))?.released_at).not.toBeNull();
    });
  });

  describe('media-cleanup job (UC-ME-4)', () => {
    it('deletes old pending, unclaimed ready and failed rows with their objects; keeps fresh and claimed ones', async () => {
      const owner = await fx.createVerifiedSeller();
      const api = mediaApi(t, owner.accessToken);
      const retention = worker.env.MEDIA_PENDING_RETENTION_HOURS;

      const pendingTicket = successBody<{
        media: MediaDto;
        upload: { url: string; fields: Record<string, string>; expiresAt: string };
      }>(
        await api.requestUpload({ purpose: 'product_image', contentType: 'image/png', sizeBytes: 5000 }),
      ).data;
      await postToStorage(pendingTicket.upload, await testImage(300, 300, 'png'), 'image/png');
      const ready = await processed(
        api,
        (await api.upload('product_image', await testImage(300, 300, 'png'), 'image/png')).ticket.media.id,
      );
      const failed = await processed(
        api,
        (await api.upload('product_image', await testImage(100, 100, 'png'), 'image/png')).ticket.media.id,
      );
      const claimed = await processed(
        api,
        (await api.upload('product_image', await testImage(300, 300, 'png'), 'image/png')).ticket.media.id,
      );
      await t.infra.db.run((trx) =>
        mediaService.claim([claimed.id], { purpose: 'product_image', ownerUserId: owner.userId }, trx),
      );
      const fresh = await processed(
        api,
        (await api.upload('product_image', await testImage(300, 300, 'png'), 'image/png')).ticket.media.id,
      );
      for (const id of [pendingTicket.media.id, ready.id, failed.id, claimed.id])
        await age(id, retention + 1);

      expect(await cleanup.run()).toBeGreaterThanOrEqual(3);

      for (const id of [pendingTicket.media.id, ready.id, failed.id]) expect(await row(id)).toBeUndefined();
      expect(await objectExists(`uploads/${pendingTicket.media.id}`)).toBe(false);
      for (const size of ['thumb', 'medium', 'large']) {
        expect(await objectExists(`public/${ready.id}/${size}.webp`)).toBe(false);
        expect(await objectExists(`public/${claimed.id}/${size}.webp`)).toBe(true);
      }
      expect((await row(claimed.id))?.status).toBe('ready');
      expect((await row(fresh.id))?.status).toBe('ready');
    });

    it('a released row is deleted, unless another FK still references it: then retained for good', async () => {
      const owner = await fx.createVerifiedSeller();
      const api = mediaApi(t, owner.accessToken);
      const free = await processed(
        api,
        (await api.upload('product_image', await testImage(300, 300, 'png'), 'image/png')).ticket.media.id,
      );
      const held = await processed(
        api,
        (await api.upload('product_image', await testImage(300, 300, 'png'), 'image/png')).ticket.media.id,
      );
      // Stands in for an order item snapshot (spec 09 v2.0): an FK the owning module didn't remove.
      await knex().raw(
        `CREATE TABLE IF NOT EXISTS test_media_refs (media_id UUID NOT NULL REFERENCES media_objects (id) ON DELETE RESTRICT)`,
      );
      await knex()('test_media_refs').insert({ media_id: held.id });
      for (const id of [free.id, held.id]) {
        await t.infra.db.run(async (trx) => {
          await mediaService.claim([id], { purpose: 'product_image', ownerUserId: owner.userId }, trx);
          await mediaService.release([id], trx);
        });
      }

      await cleanup.run();
      expect(await row(free.id)).toBeUndefined();
      expect(await objectExists(`public/${free.id}/large.webp`)).toBe(false);
      expect((await row(held.id))?.retained_at).not.toBeNull();
      expect(await objectExists(`public/${held.id}/large.webp`)).toBe(true);

      // Retained rows are never candidates again.
      await cleanup.run();
      expect((await row(held.id))?.retained_at).not.toBeNull();
    });

    it('two workers running at once handle each row once', async () => {
      const owner = await fx.createVerifiedSeller();
      const api = mediaApi(t, owner.accessToken);
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await api.requestUpload({
          purpose: 'product_image',
          contentType: 'image/png',
          sizeBytes: 10,
        });
        const id = successBody<{ media: MediaDto }>(res).data.media.id;
        await age(id, worker.env.MEDIA_PENDING_RETENTION_HOURS + 1);
        ids.push(id);
      }
      await Promise.all([cleanup.run(), cleanup.run()]);
      for (const id of ids) expect(await row(id)).toBeUndefined();
    });

    it('a processing row stuck for over an hour is never cleaned up and is logged as MEDIA_PROCESSING_STUCK', async () => {
      const owner = await fx.createVerifiedSeller();
      const [stuck] = await knex()('media_objects')
        .insert({
          owner_user_id: owner.userId,
          purpose: 'product_image',
          status: 'processing',
          declared_content_type: 'image/png',
          declared_size_bytes: 10,
          created_at: knex().raw(`now() - interval '3 days'`),
          updated_at: knex().raw(`now() - interval '2 hours'`),
        })
        .returning<{ id: string }[]>('id');
      workerLogs.clear();
      await cleanup.run();
      expect((await row(stuck?.id ?? ''))?.status).toBe('processing');
      const logged = workerLogs.entries().find((entry) => entry.event === 'MEDIA_PROCESSING_STUCK');
      expect(logged).toMatchObject({ level: 'error' });
      expect(logged?.mediaIds).toContain(stuck?.id);
    });
  });

  it('readiness reports storage', async () => {
    const res = await request(t.app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(successBody<{ checks: Record<string, { status: string }> }>(res).data.checks.storage?.status).toBe(
      'up',
    );
  });
});
