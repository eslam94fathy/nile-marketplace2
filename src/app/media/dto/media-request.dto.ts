import { IsIn } from 'class-validator';
import { IntField, UuidField } from '../../../lib/http';
import { type ImageContentType } from '../../../pkg/image';
import { UPLOAD_CONTENT_TYPES } from '../constants';
import { MediaPurpose } from '../enums';

/** Request DTOs for spec 14 §4. Notation: docs/spec/01-api-conventions.md §1.1. */

export class CreateUploadDto {
  @IsIn(Object.values(MediaPurpose))
  purpose!: MediaPurpose;

  @IsIn(UPLOAD_CONTENT_TYPES)
  contentType!: ImageContentType;

  /** The upper bound is `MEDIA_MAX_UPLOAD_BYTES`, checked by the service (env, not a constant). */
  @IntField(1, Number.MAX_SAFE_INTEGER)
  sizeBytes!: number;
}

export class MediaIdParamsDto {
  @UuidField()
  mediaId!: string;
}
