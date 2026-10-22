import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { RETURNS_TABLES } from '../constants';
import { type PhotoUploader } from '../enums';
import { type ReturnPhoto } from '../model/return-request.model';

const T = RETURNS_TABLES.PHOTOS;

interface ReturnPhotoTable {
  return_id: string;
  media_id: string;
  uploaded_by: PhotoUploader;
  position: number;
}

const toModel = (row: ReturnPhotoTable): ReturnPhoto => ({
  returnId: row.return_id,
  mediaId: row.media_id,
  uploadedBy: row.uploaded_by,
  position: row.position,
});

/** All SQL of `return_photos` (spec 18 §1). The media rows are claimed and released by the caller. */
@injectable()
export class ReturnPhotoRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /** One multi-row insert; positions follow the order the client sent. */
  async insertMany(
    returnId: string,
    uploadedBy: PhotoUploader,
    mediaIds: readonly string[],
    trx: DbTransaction,
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    await trx<ReturnPhotoTable>(T).insert(
      mediaIds.map((mediaId, position) => ({
        return_id: returnId,
        media_id: mediaId,
        uploaded_by: uploadedBy,
        position,
      })),
    );
  }

  /** Photos of a page of requests, in slot order: one query on the primary key (G20). */
  async findByReturnIds(returnIds: readonly string[]): Promise<ReturnPhoto[]> {
    if (returnIds.length === 0) return [];
    const rows = await this.db
      .knex<ReturnPhotoTable>(T)
      .select('return_id', 'media_id', 'uploaded_by', 'position')
      .whereIn('return_id', [...new Set(returnIds)])
      .orderBy([{ column: 'return_id' }, { column: 'uploaded_by' }, { column: 'position' }]);
    return rows.map(toModel);
  }

  /** Drops the request's photo rows (UC-RE-5) and returns their media ids for `media.release`. */
  async deleteByReturnId(returnId: string, trx: DbTransaction): Promise<string[]> {
    const rows = await trx<ReturnPhotoTable>(T).where({ return_id: returnId }).delete().returning('media_id');
    return rows.map((row: { media_id: string }) => row.media_id);
  }
}
