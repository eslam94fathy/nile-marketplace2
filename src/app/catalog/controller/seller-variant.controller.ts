import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, parseListQuery, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import { Money } from '../../../lib/money';
import { INVENTORY_MOVEMENT_LIST_SPEC } from '../../inventory';
import {
  CreateVariantDto,
  ProductIdParamsDto,
  ProductVariantParamsDto,
  StockAdjustmentDto,
  UpdateVariantDto,
  VariantIdParamsDto,
} from '../dto/product-request.dto';
import { toSellerVariantDto, toStockMovementDto, toVariantStockDto } from '../dto/product-response.dto';
import { type SellerVariantService } from '../service/seller-variant.service';
import { userOf } from './seller-product.controller';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

const moneyOrNull = (value: string | null | undefined): Money | null | undefined =>
  value === undefined ? undefined : value === null ? null : Money.of(value);

/** HTTP only (spec 06 §4.3, variants and stock). Seller-guarded in routes. */
@injectable()
export class SellerVariantController {
  constructor(
    @inject(TOKENS.SellerVariantService) private readonly variants: SellerVariantService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    const body = await validateDto(CreateVariantDto, req.body);
    const view = await this.variants.create(userOf(req), productId, {
      sku: body.sku,
      price: Money.of(body.price),
      compareAtPrice: moneyOrNull(body.compareAtPrice) ?? null,
      optionIds: body.optionIds,
      initialStock: body.initialStock,
      status: body.status,
    });
    sendSuccess(res, HTTP_STATUS.CREATED, toSellerVariantDto(view));
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { productId, variantId } = await validateDto(ProductVariantParamsDto, req.params);
    const body = await validateDto(UpdateVariantDto, req.body);
    const view = await this.variants.update(userOf(req), productId, variantId, {
      sku: body.sku,
      price: body.price === undefined ? undefined : Money.of(body.price),
      compareAtPrice: moneyOrNull(body.compareAtPrice),
      status: body.status,
    });
    sendSuccess(res, HTTP_STATUS.OK, toSellerVariantDto(view));
  };

  delete = async (req: Request, res: Response): Promise<void> => {
    const { productId, variantId } = await validateDto(ProductVariantParamsDto, req.params);
    await this.variants.delete(userOf(req), productId, variantId);
    sendNoContent(res);
  };

  adjustStock = async (req: Request, res: Response): Promise<void> => {
    const { variantId } = await validateDto(VariantIdParamsDto, req.params);
    const { delta } = await validateDto(StockAdjustmentDto, req.body);
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      toVariantStockDto(await this.variants.adjustStock(userOf(req), variantId, delta)),
    );
  };

  movements = async (req: Request, res: Response): Promise<void> => {
    const { variantId } = await validateDto(VariantIdParamsDto, req.params);
    const query = parseListQuery(req.query, INVENTORY_MOVEMENT_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.variants.listMovements(userOf(req), variantId, query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toStockMovementDto), page.meta);
  };
}
