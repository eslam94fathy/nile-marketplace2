import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, sendSuccess, validateDto } from '../../../lib/http';
import { CategoryIdParamsDto } from '../dto/category-request.dto';
import { toCategoryNodeDto, toEffectiveAttributeDto } from '../dto/category-response.dto';
import { type CategoryService } from '../service/category.service';

/** HTTP only (spec 06 §4.1, public). */
@injectable()
export class CategoryController {
  constructor(@inject(TOKENS.CategoryService) private readonly categories: CategoryService) {}

  tree = async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, HTTP_STATUS.OK, (await this.categories.activeTree()).map(toCategoryNodeDto));
  };

  attributes = async (req: Request, res: Response): Promise<void> => {
    const { categoryId } = await validateDto(CategoryIdParamsDto, req.params);
    const attributes = await this.categories.effectiveAttributes(categoryId);
    sendSuccess(res, HTTP_STATUS.OK, attributes.map(toEffectiveAttributeDto));
  };
}
