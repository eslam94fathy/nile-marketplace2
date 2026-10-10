import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import {
  CreateProductDto,
  ProductIdParamsDto,
  SELLER_PRODUCT_LIST_SPEC,
  UpdateProductDto,
} from '../dto/product-request.dto';
import { toSellerProductDetailDto, toSellerProductDto } from '../dto/product-response.dto';
import { type SellerProductService } from '../service/seller-product.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 06 §4.3, products). Seller-guarded in routes. */
@injectable()
export class SellerProductController {
  constructor(
    @inject(TOKENS.SellerProductService) private readonly products: SellerProductService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, SELLER_PRODUCT_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.products.list(userOf(req), query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toSellerProductDto), page.meta);
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const { categoryId, name, description } = await validateDto(CreateProductDto, req.body);
    const detail = await this.products.create(userOf(req), { categoryId, name, description });
    sendSuccess(res, HTTP_STATUS.CREATED, toSellerProductDetailDto(detail));
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      toSellerProductDetailDto(await this.products.get(userOf(req), productId)),
    );
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    const { name, description, categoryId } = await validateDto(UpdateProductDto, req.body);
    const detail = await this.products.update(userOf(req), productId, { name, description, categoryId });
    sendSuccess(res, HTTP_STATUS.OK, toSellerProductDetailDto(detail));
  };

  activate = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      toSellerProductDetailDto(await this.products.activate(userOf(req), productId)),
    );
  };

  deactivate = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    const detail = await this.products.deactivate(userOf(req), productId);
    sendSuccess(res, HTTP_STATUS.OK, toSellerProductDetailDto(detail));
  };

  delete = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    await this.products.delete(userOf(req), productId);
    sendNoContent(res);
  };
}

export function userOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}
