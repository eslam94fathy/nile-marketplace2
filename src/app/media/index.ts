/**
 * media module (docs/spec/14-media.md): image uploads to object storage, processing, cleanup.
 * Owns tables: media_objects. Depends on no other module.
 * Public API: `MediaService` (claim / release / getImages, TOKENS.MediaService) for catalog, support,
 * reviews and returns, which keep their own reference rows with an FK to media_objects (RESTRICT).
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { type Env } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import { type EventHandlerDefinition, MediaUploaded } from '../../lib/events';
import { type OpenApiRegistry } from '../../lib/http';
import { type JobDefinition } from '../../lib/jobs';
import { type RateLimiters } from '../../lib/middleware';
import { MEDIA_CLEANUP_JOB, MEDIA_PROCESSING_PREFETCH, MEDIA_PROCESSING_QUEUE } from './constants';
import { MediaController } from './controller/media.controller';
import { MediaObjectRepository } from './repository/media-object.repository';
import { mediaRoutes } from './routes';
import { MediaCleanupJob } from './service/media-cleanup.job';
import { MediaProcessingService, type ProcessingOutcome } from './service/media-processing.service';
import { MediaService } from './service/media.service';
import { MediaUploadService } from './service/media-upload.service';
import { MediaUrls } from './service/media-urls';

export { MediaPurpose, ImageSize } from './enums';
export { MediaErrorCode } from './errors';
export { ImageDto, toImageDto } from './dto/media-response.dto';
export { type MediaService, type ClaimOptions, NotAttachableReason } from './service/media.service';
export { type ImageView } from './service/media-urls';

/** api process: endpoints and the public API. Needs TOKENS.ObjectStorage. */
export function registerMediaModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.MediaObjectRepository, MediaObjectRepository);
  container.registerSingleton(TOKENS.MediaUrls, MediaUrls);
  container.registerSingleton(TOKENS.MediaService, MediaService);
  container.registerSingleton(TOKENS.MediaUploadService, MediaUploadService);
  container.registerSingleton(TOKENS.MediaController, MediaController);
}

/** worker process: processing and cleanup. Needs TOKENS.ObjectStorage and TOKENS.ImageProcessor. */
export function registerMediaWorker(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.MediaObjectRepository, MediaObjectRepository);
  container.registerSingleton(TOKENS.MediaProcessingService, MediaProcessingService);
  container.registerSingleton(TOKENS.MediaCleanupJob, MediaCleanupJob);
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createMediaRouter(container: DependencyContainer, basePath: string): Router {
  return mediaRoutes({
    media: container.resolve<MediaController>(TOKENS.MediaController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    rateLimiters: container.resolve<RateLimiters>(TOKENS.RateLimiters),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}

/** Consumer `media.processing` ← `media.uploaded` (UC-ME-3), one message at a time (A-6). */
export function createMediaHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  const service = container.resolve<MediaProcessingService>(TOKENS.MediaProcessingService);
  return [
    {
      name: MEDIA_PROCESSING_QUEUE,
      events: [MediaUploaded],
      prefetch: MEDIA_PROCESSING_PREFETCH,
      // Storage reads and writes and the CPU work happen outside the DB transaction (CLAUDE.md §6.4).
      beforeTransaction: (envelope) => service.process(envelope),
      handle: (_envelope, trx, prepared) => service.record(prepared as ProcessingOutcome, trx),
    },
  ];
}

export function createMediaJobs(
  container: DependencyContainer,
  env: Pick<
    Env,
    'JOB_MEDIA_CLEANUP_INTERVAL_MS' | 'MEDIA_PENDING_RETENTION_HOURS' | 'MEDIA_CLEANUP_BATCH_SIZE'
  >,
): JobDefinition[] {
  const cleanup = container.resolve<MediaCleanupJob>(TOKENS.MediaCleanupJob);
  return [
    {
      name: MEDIA_CLEANUP_JOB,
      intervalMs: env.JOB_MEDIA_CLEANUP_INTERVAL_MS,
      run: () =>
        cleanup.run({
          retentionHours: env.MEDIA_PENDING_RETENTION_HOURS,
          batchSize: env.MEDIA_CLEANUP_BATCH_SIZE,
        }),
    },
  ];
}
