import { defineEvent } from './define-event';
import { type MediaFailureReasonValue, type MediaPurposeValue } from './shared-types';

/** Publisher: media (permanent processing failure, UC-ME-3). Consumer: realtime (spec 15). */
export interface MediaFailedPayload {
  mediaId: string;
  purpose: MediaPurposeValue;
  ownerUserId: string;
  reason: MediaFailureReasonValue;
}

export const MediaFailed = defineEvent<MediaFailedPayload>('media.failed', 1, 'media_object');
