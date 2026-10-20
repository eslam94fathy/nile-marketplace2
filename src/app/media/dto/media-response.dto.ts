import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsUrl, IsUUID, ValidateNested } from 'class-validator';
import { MediaFailureReason, MediaPurpose, MediaStatus } from '../enums';
import { type ImageView } from '../service/media-urls';
import { type MediaView, type UploadTicket } from '../service/media-upload.service';

/* Response DTOs for spec 14 §2 and §4 (decorators describe the OpenAPI shape only). */

export class ImageUrlsDto {
  @IsUrl()
  thumb!: string;

  @IsUrl()
  medium!: string;

  @IsUrl()
  large!: string;
}

/** The shared image shape of every response that shows an image (conventions §9.1). */
export class ImageDto {
  @IsUUID()
  id!: string;

  @ValidateNested()
  @Type(() => ImageUrlsDto)
  urls!: ImageUrlsDto;

  /** Of the processed large image. */
  @IsInt()
  width!: number;

  @IsInt()
  height!: number;
}

export class MediaDto {
  @IsUUID()
  id!: string;

  @IsIn(Object.values(MediaPurpose))
  purpose!: MediaPurpose;

  @IsIn(Object.values(MediaStatus))
  status!: MediaStatus;

  // Nullable: set only when failed.
  @IsOptional()
  @IsIn(Object.values(MediaFailureReason))
  failureReason!: MediaFailureReason | null;

  // Nullable: only when ready.
  @IsOptional()
  @ValidateNested()
  @Type(() => ImageDto)
  image!: ImageDto | null;

  @IsISO8601()
  createdAt!: string;
}

export class UploadFormDto {
  /** POST a `multipart/form-data` form here: every field below, then the file as `file`. */
  @IsUrl()
  url!: string;

  @IsObject()
  fields!: Record<string, string>;

  @IsISO8601()
  expiresAt!: string;
}

export class UploadTicketDto {
  @ValidateNested()
  @Type(() => MediaDto)
  media!: MediaDto;

  @ValidateNested()
  @Type(() => UploadFormDto)
  upload!: UploadFormDto;
}

export function toImageDto(image: ImageView): ImageDto {
  return { id: image.id, urls: { ...image.urls }, width: image.width, height: image.height };
}

export function toMediaDto({ media, image }: MediaView): MediaDto {
  return {
    id: media.id,
    purpose: media.purpose,
    status: media.status,
    failureReason: media.failureReason,
    image: image ? toImageDto(image) : null,
    createdAt: media.createdAt.toISOString(),
  };
}

export function toUploadTicketDto(ticket: UploadTicket): UploadTicketDto {
  return {
    media: toMediaDto(ticket),
    upload: {
      url: ticket.upload.url,
      fields: ticket.upload.fields,
      expiresAt: ticket.upload.expiresAt.toISOString(),
    },
  };
}
