import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, parseListQuery, sendSuccess } from '../../../lib/http';
import {
  parseIdOrSlug,
  PRODUCT_BROWSE_LIST_SPEC,
  PRODUCT_SEARCH_LIST_SPEC,
  toProductDetailDto,
  toProductListItemDto,
} from '../dto/product-public.dto';
import { PRODUCT_LIST_PARAMS, type ProductBrowseService } from '../service/product-browse.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 06 §4.1, public products). */
@injectable()
export class ProductController {
  constructor(
    @inject(TOKENS.ProductBrowseService) private readonly browse: ProductBrowseService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const searching = req.query[PRODUCT_LIST_PARAMS.Q] !== undefined;
    const query = parseListQuery(req.query, searching ? PRODUCT_SEARCH_LIST_SPEC : PRODUCT_BROWSE_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.browse.list(query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toProductListItemDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const detail = await this.browse.detail(parseIdOrSlug(req.params.idOrSlug));
    sendSuccess(res, HTTP_STATUS.OK, toProductDetailDto(detail));
  };
}
