import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { MediaPurpose, type MediaService } from '../../media';
import { type SupportMessage } from '../model/support-message.model';
import { type SupportAttachmentRepository } from '../repository/support-attachment.repository';

/** Private images on a message (spec 16 §1, R-9, spec 14 ME-1), api only. */
@injectable()
export class SupportAttachmentService {
  constructor(
    @inject(TOKENS.SupportAttachmentRepository) private readonly attachments: SupportAttachmentRepository,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
  ) {}

  /** Claims the images (ticket already locked: lock order ticket → media rows) and records them. */
  async attach(
    message: SupportMessage,
    ownerUserId: string,
    mediaIds: readonly string[],
    trx: DbTransaction,
  ): Promise<void> {
    await this.media.claim(mediaIds, { purpose: MediaPurpose.SUPPORT_ATTACHMENT, ownerUserId }, trx);
    await this.attachments.insertMany(message.id, mediaIds, trx);
  }
}
