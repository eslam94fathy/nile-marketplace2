import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { CUSTOMER_LIST_SPEC, CustomerIdParamsDto } from '../dto/customer-request.dto';
import { toAdminCustomerDetailDto, toAdminCustomerDto } from '../dto/customer-response.dto';
import { type CustomerAdminService } from '../service/customer-admin.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 20 §3.3). Admin-guarded in routes. */
@injectable()
export class CustomerAdminController {
  constructor(
    @inject(TOKENS.CustomerAdminService) private readonly admin: CustomerAdminService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, CUSTOMER_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.admin.list(query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toAdminCustomerDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { customerId } = await validateDto(CustomerIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAdminCustomerDetailDto(await this.admin.detail(customerId)));
  };
}
