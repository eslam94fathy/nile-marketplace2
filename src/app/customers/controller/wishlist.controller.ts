import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { invalidQuery } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import {
  toWishlistItemDto,
  WISHLIST_LIST_SPEC,
  type WishlistProductIdsDto,
  WishlistProductParamsDto,
} from '../dto/wishlist.dto';
import { type CustomerService } from '../service/customer.service';
import { type WishlistService } from '../service/wishlist.service';
import { userIdOf } from './customer.controller';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 04 §8.4): the customer's own wishlist. */
@injectable()
export class WishlistController {
  constructor(
    @inject(TOKENS.WishlistService) private readonly wishlist: WishlistService,
    @inject(TOKENS.CustomerService) private readonly customers: CustomerService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, WISHLIST_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    // Newest first only (spec 04 §8.4).
    if (query.sort.direction !== 'desc') {
      throw invalidQuery([{ field: 'sort', constraint: 'isIn', message: 'only -addedAt is supported' }]);
    }
    const page = await this.wishlist.list(await this.customerIdOf(req), query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toWishlistItemDto), page.meta);
  };

  productIds = async (req: Request, res: Response): Promise<void> => {
    const productIds = await this.wishlist.productIds(await this.customerIdOf(req));
    sendSuccess<WishlistProductIdsDto>(res, HTTP_STATUS.OK, { productIds });
  };

  add = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(WishlistProductParamsDto, req.params);
    await this.wishlist.add(await this.customerIdOf(req), productId);
    sendNoContent(res);
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(WishlistProductParamsDto, req.params);
    await this.wishlist.remove(await this.customerIdOf(req), productId);
    sendNoContent(res);
  };

  private async customerIdOf(req: Request): Promise<string> {
    return (await this.customers.requireByUserId(userIdOf(req))).id;
  }
}
