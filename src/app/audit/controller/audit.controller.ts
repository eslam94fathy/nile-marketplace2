import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { invalidQuery } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { AUDIT_LOG_LIST_SPEC, AuditEntryIdParamsDto } from '../dto/audit-request.dto';
import { toAuditEntryDto } from '../dto/audit-response.dto';
import { type AuditViewService } from '../service/audit-view.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 20 §2.5). Routes are admin-guarded. */
@injectable()
export class AuditController {
  constructor(
    @inject(TOKENS.AuditViewService) private readonly view: AuditViewService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, AUDIT_LOG_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const fields = new Set(query.filters.map((filter) => filter.field));
    // A target id alone is ambiguous across target types, and the index needs both (spec 20 §2.5).
    if (fields.has('targetId') && !fields.has('targetType')) {
      throw invalidQuery([
        { field: 'targetId', constraint: 'requires', message: 'targetId needs targetType[eq]' },
      ]);
    }
    const page = await this.view.list(query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toAuditEntryDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { entryId } = await validateDto(AuditEntryIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAuditEntryDto(await this.view.get(entryId)));
  };
}
