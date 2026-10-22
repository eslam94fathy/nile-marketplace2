import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, sendSuccess, validateDto } from '../../../lib/http';
import { BlockProductDto, ProductIdParamsDto } from '../dto/product-request.dto';
import { toAdminProductDetailDto } from '../dto/product-response.dto';
import { type ProductBlockService } from '../service/product-block.service';

/** HTTP only (spec 20 §3.4). Admin-guarded in routes. */
@injectable()
export class ProductBlockController {
  constructor(@inject(TOKENS.ProductBlockService) private readonly blocks: ProductBlockService) {}

  get = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    await this.respond(res, productId);
  };

  block = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    const { reason } = await validateDto(BlockProductDto, req.body);
    await this.blocks.block(productId, reason);
    await this.respond(res, productId);
  };

  unblock = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    await this.blocks.unblock(productId);
    await this.respond(res, productId);
  };

  private async respond(res: Response, productId: string): Promise<void> {
    const { sellerId, detail } = await this.blocks.detail(productId);
    sendSuccess(res, HTTP_STATUS.OK, toAdminProductDetailDto(sellerId, detail));
  }
}
