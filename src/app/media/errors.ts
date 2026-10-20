import { AppError, type ErrorDetail } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** media error codes (docs/spec/14-media.md §6). */
export const MediaErrorCode = {
  MEDIA_NOT_FOUND: 'MEDIA_NOT_FOUND',
  MEDIA_PURPOSE_NOT_ALLOWED: 'MEDIA_PURPOSE_NOT_ALLOWED',
  MEDIA_OPEN_UPLOAD_LIMIT_REACHED: 'MEDIA_OPEN_UPLOAD_LIMIT_REACHED',
  MEDIA_UPLOAD_MISSING: 'MEDIA_UPLOAD_MISSING',
  MEDIA_UPLOAD_INVALID: 'MEDIA_UPLOAD_INVALID',
  MEDIA_INVALID_STATUS: 'MEDIA_INVALID_STATUS',
  MEDIA_NOT_ATTACHABLE: 'MEDIA_NOT_ATTACHABLE',
} as const;

export const mediaNotFound = () =>
  new AppError(MediaErrorCode.MEDIA_NOT_FOUND, 'Media not found', HTTP_STATUS.NOT_FOUND);

export const mediaPurposeNotAllowed = () =>
  new AppError(
    MediaErrorCode.MEDIA_PURPOSE_NOT_ALLOWED,
    'Your role may not upload media for this purpose',
    HTTP_STATUS.FORBIDDEN,
  );

export const mediaOpenUploadLimitReached = () =>
  new AppError(
    MediaErrorCode.MEDIA_OPEN_UPLOAD_LIMIT_REACHED,
    'Too many uploads are still pending or processing',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
  );

export const mediaUploadMissing = () =>
  new AppError(
    MediaErrorCode.MEDIA_UPLOAD_MISSING,
    'The file has not reached storage yet',
    HTTP_STATUS.CONFLICT,
  );

export const mediaUploadInvalid = () =>
  new AppError(
    MediaErrorCode.MEDIA_UPLOAD_INVALID,
    'The uploaded file is too large or does not match its declared type',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
  );

export const mediaInvalidStatus = () =>
  new AppError(MediaErrorCode.MEDIA_INVALID_STATUS, 'This upload has failed', HTTP_STATUS.CONFLICT);

export const mediaNotAttachable = (details: readonly ErrorDetail[]) =>
  new AppError(
    MediaErrorCode.MEDIA_NOT_ATTACHABLE,
    'Some media cannot be attached',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
    { details },
  );
