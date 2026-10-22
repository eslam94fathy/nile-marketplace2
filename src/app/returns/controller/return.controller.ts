import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated, validationFailed } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { RefundPayoutMethod } from '../enums';
import {
  CUSTOMER_RETURN_LIST_SPEC,
  EscalateReturnDto,
  type RefundPayoutDto,
  RequestReturnDto,
  ReturnableItemsParamsDto,
  ReturnIdParamsDto,
} from '../dto/return-request.dto';
import { toReturnableItemsDto, toReturnDto } from '../dto/return-response.dto';
import { type RefundPayout } from '../model/return-request.model';
import { type ReturnRequestService } from '../service/return-request.service';
import { type ReturnViewService } from '../service/return-view.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 18 §4.1): the customer's returns. */
@injectable()
export class ReturnController {
  constructor(
    @inject(TOKENS.ReturnRequestService) private readonly returns: ReturnRequestService,
    @inject(TOKENS.ReturnViewService) private readonly views: ReturnViewService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  returnableItems = async (req: Request, res: Response): Promise<void> => {
    const { orderId, sellerOrderId } = await validateDto(ReturnableItemsParamsDto, req.params);
    const view = await this.returns.returnableItems(userIdOf(req), orderId, sellerOrderId);
    sendSuccess(res, HTTP_STATUS.OK, toReturnableItemsDto(view));
  };

  request = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(RequestReturnDto, req.body);
    const request = await this.returns.request(userIdOf(req), {
      sellerOrderId: dto.sellerOrderId,
      reason: dto.reason,
      description: dto.description ?? null,
      items: dto.items,
      photoMediaIds: dto.photoMediaIds ?? [],
      refundPayout: dto.refundPayout ? toRefundPayout(dto.refundPayout) : null,
    });
    sendSuccess(res, HTTP_STATUS.CREATED, toReturnDto(await this.views.viewOf(request)));
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const customerId = await this.returns.customerIdOf(userIdOf(req));
    const query = parseListQuery(req.query, CUSTOMER_RETURN_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.views.list({ customerId }, query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toReturnDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { returnId } = await validateDto(ReturnIdParamsDto, req.params);
    const customerId = await this.returns.customerIdOf(userIdOf(req));
    sendSuccess(res, HTTP_STATUS.OK, toReturnDto(await this.views.get({ customerId }, returnId)));
  };

  cancel = async (req: Request, res: Response): Promise<void> => {
    const { returnId } = await validateDto(ReturnIdParamsDto, req.params);
    const cancelled = await this.returns.cancel(userIdOf(req), returnId);
    sendSuccess(res, HTTP_STATUS.OK, toReturnDto(await this.views.viewOf(cancelled)));
  };

  escalate = async (req: Request, res: Response): Promise<void> => {
    const { returnId } = await validateDto(ReturnIdParamsDto, req.params);
    const { note } = await validateDto(EscalateReturnDto, req.body);
    const escalated = await this.returns.escalate(userIdOf(req), returnId, note);
    sendSuccess(res, HTTP_STATUS.OK, toReturnDto(await this.views.viewOf(escalated)));
  };
}

export function userIdOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}

/** Exactly the field of the chosen method (RE-8); the other one is a 400 like any body error. */
function toRefundPayout(dto: RefundPayoutDto): RefundPayout {
  const wallet = dto.method === RefundPayoutMethod.MOBILE_WALLET;
  const [needed, stray] = wallet
    ? (['walletNumber', 'instapayAddress'] as const)
    : (['instapayAddress', 'walletNumber'] as const);
  const problems = [
    ...(dto[needed] === undefined
      ? [
          {
            field: `refundPayout.${needed}`,
            constraint: 'required',
            message: `${needed} is required for ${dto.method}`,
          },
        ]
      : []),
    ...(dto[stray] !== undefined
      ? [
          {
            field: `refundPayout.${stray}`,
            constraint: 'not_allowed',
            message: `${stray} is not allowed for ${dto.method}`,
          },
        ]
      : []),
  ];
  if (problems.length > 0) throw validationFailed(problems);
  return wallet
    ? { method: RefundPayoutMethod.MOBILE_WALLET, walletNumber: dto.walletNumber ?? '' }
    : { method: RefundPayoutMethod.INSTAPAY, instapayAddress: dto.instapayAddress ?? '' };
}
