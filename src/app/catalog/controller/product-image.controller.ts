import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import {
  AddProductImageDto,
  ProductImageParamsDto,
  ReorderProductImagesDto,
  toProductImageDto,
  UpdateProductImageDto,
} from '../dto/product-image.dto';
import { ProductIdParamsDto } from '../dto/product-request.dto';
import { type ProductImageService } from '../service/product-image.service';
import { userOf } from './seller-product.controller';

/** HTTP only (spec 06 §8.4, seller images). Seller-guarded in routes. */
@injectable()
export class ProductImageController {
  constructor(@inject(TOKENS.ProductImageService) private readonly images: ProductImageService) {}

  add = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    const { mediaId, variantId, altText, position } = await validateDto(AddProductImageDto, req.body);
    const images = await this.images.add(userOf(req), productId, { mediaId, variantId, altText, position });
    sendSuccess(res, HTTP_STATUS.CREATED, images.map(toProductImageDto));
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { productId, imageId } = await validateDto(ProductImageParamsDto, req.params);
    const { variantId, altText } = await validateDto(UpdateProductImageDto, req.body);
    const image = await this.images.update(userOf(req), productId, imageId, { variantId, altText });
    sendSuccess(res, HTTP_STATUS.OK, toProductImageDto(image));
  };

  reorder = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    const { imageIds } = await validateDto(ReorderProductImagesDto, req.body);
    const images = await this.images.reorder(userOf(req), productId, imageIds);
    sendSuccess(res, HTTP_STATUS.OK, images.map(toProductImageDto));
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const { productId, imageId } = await validateDto(ProductImageParamsDto, req.params);
    await this.images.remove(userOf(req), productId, imageId);
    sendNoContent(res);
  };
}
