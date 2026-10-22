import { Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, byUser, RateLimitClass, type RateLimiters, requireRole } from '../../lib/middleware';
import { MEDIA_PATHS as P } from './constants';
import { type MediaController } from './controller/media.controller';
import { CreateUploadDto } from './dto/media-request.dto';
import { MediaDto, UploadTicketDto } from './dto/media-response.dto';

const TAGS = ['media'] as const;

export interface MediaRouteDeps {
  media: MediaController;
  jwtVerifier: JwtVerifier;
  rateLimiters: RateLimiters;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/**
 * Spec 14 §4: customers, sellers and admins (delivery agents upload nothing). The upload endpoints
 * are in rate class `upload` per user (ME-6); no Idempotency-Key (no money or stock effect).
 */
export function mediaRoutes(deps: MediaRouteDeps): Router {
  const { media, docs, basePath } = deps;
  const router = Router();
  const uploaders = [
    authenticate(deps.jwtVerifier),
    requireRole(UserRole.CUSTOMER, UserRole.SELLER, UserRole.ADMIN),
  ];
  const uploadLimit = deps.rateLimiters.limit(RateLimitClass.UPLOAD, byUser);

  router.post(P.UPLOADS, ...uploaders, uploadLimit, media.requestUpload);
  router.post(P.COMPLETE, ...uploaders, uploadLimit, media.complete);
  router.get(P.MEDIA, ...uploaders, media.get);

  const common = { tags: TAGS, auth: true } as const;
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.UPLOADS}`,
    summary:
      'Start an upload: returns a presigned form to POST the file straight to storage, valid for a few minutes (MEDIA_PURPOSE_NOT_ALLOWED, MEDIA_OPEN_UPLOAD_LIMIT_REACHED)',
    requestBody: CreateUploadDto,
    responses: { 201: { description: 'The pending media and its upload form', body: UploadTicketDto } },
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.COMPLETE}`,
    summary:
      'Tell the api the file is in storage; the image is then processed in the background (MEDIA_NOT_FOUND, MEDIA_UPLOAD_MISSING, MEDIA_UPLOAD_INVALID, MEDIA_INVALID_STATUS, SERVICE_UNAVAILABLE)',
    responses: {
      202: { description: 'Accepted: processing', body: MediaDto },
      200: { description: 'Already processing or ready (a retried call)', body: MediaDto },
    },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.MEDIA}`,
    summary: 'My upload, for polling until it is ready or failed (MEDIA_NOT_FOUND)',
    responses: { 200: { description: 'The media', body: MediaDto } },
  });
  return router;
}
