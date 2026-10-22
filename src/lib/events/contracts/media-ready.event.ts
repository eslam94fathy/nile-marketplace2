import { defineEvent } from './define-event';
import { type MediaPurposeValue } from './shared-types';

/** Publisher: media (processing done, UC-ME-3). Consumer: realtime (spec 15). */
export interface MediaReadyPayload {
  mediaId: string;
  purpose: MediaPurposeValue;
  ownerUserId: string;
}

export const MediaReady = defineEvent<MediaReadyPayload>('media.ready', 1, 'media_object');
