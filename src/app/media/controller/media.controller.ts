import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, sendSuccess, validateDto } from '../../../lib/http';
import { CreateUploadDto, MediaIdParamsDto } from '../dto/media-request.dto';
import { toMediaDto, toUploadTicketDto } from '../dto/media-response.dto';
import { type MediaUploadService } from '../service/media-upload.service';

/** HTTP only (spec 14 §4). Routes are authenticated. */
@injectable()
export class MediaController {
  constructor(@inject(TOKENS.MediaUploadService) private readonly uploads: MediaUploadService) {}

  requestUpload = async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw unauthenticated();
    const body = await validateDto(CreateUploadDto, req.body);
    const ticket = await this.uploads.requestUpload({ userId: req.auth.userId, role: req.auth.role }, body);
    sendSuccess(res, HTTP_STATUS.CREATED, toUploadTicketDto(ticket));
  };

  complete = async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw unauthenticated();
    const { mediaId } = await validateDto(MediaIdParamsDto, req.params);
    const result = await this.uploads.complete(req.auth.userId, mediaId);
    // 202: the worker processes the image now; 200: it was already processing or ready (ME-3).
    sendSuccess(res, result.accepted ? HTTP_STATUS.ACCEPTED : HTTP_STATUS.OK, toMediaDto(result));
  };

  get = async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw unauthenticated();
    const { mediaId } = await validateDto(MediaIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toMediaDto(await this.uploads.get(req.auth.userId, mediaId)));
  };
}
