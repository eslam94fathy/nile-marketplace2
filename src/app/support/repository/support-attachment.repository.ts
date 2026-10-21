import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { SUPPORT_TABLES } from '../constants';

const T = SUPPORT_TABLES.MESSAGE_ATTACHMENTS;

interface AttachmentRow {
  message_id: string;
  media_id: string;
  position: number;
}

/** All SQL of `support_message_attachments` (spec 16 §1). The media rows are claimed by the caller. */
@injectable()
export class SupportAttachmentRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /** One multi-row insert; positions follow the order the client sent. */
  async insertMany(messageId: string, mediaIds: readonly string[], trx: DbTransaction): Promise<void> {
    if (mediaIds.length === 0) return;
    await trx<AttachmentRow>(T).insert(
      mediaIds.map((mediaId, position) => ({ message_id: messageId, media_id: mediaId, position })),
    );
  }

  /** Media ids per message, in position order: one query on the primary key for a page (G20). */
  async findMediaIds(messageIds: readonly string[]): Promise<Map<string, string[]>> {
    if (messageIds.length === 0) return new Map();
    const rows = await this.db
      .knex<AttachmentRow>(T)
      .select('message_id', 'media_id')
      .whereIn('message_id', [...new Set(messageIds)])
      .orderBy([{ column: 'message_id' }, { column: 'position' }]);
    const byMessage = new Map<string, string[]>();
    for (const row of rows) {
      byMessage.set(row.message_id, [...(byMessage.get(row.message_id) ?? []), row.media_id]);
    }
    return byMessage;
  }
}
