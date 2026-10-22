import { defineEvent } from './define-event';
import { type MediaPurposeValue } from './shared-types';

/** Publisher: media (complete, UC-ME-2). Consumer: media itself (`media.processing`). */
export interface MediaUploadedPayload {
  mediaId: string;
  purpose: MediaPurposeValue;
  ownerUserId: string;
}

export const MediaUploaded = defineEvent<MediaUploadedPayload>('media.uploaded', 1, 'media_object');
