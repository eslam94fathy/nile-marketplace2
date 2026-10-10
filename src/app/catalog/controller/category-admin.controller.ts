import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import {
  AttributeIdParamsDto,
  CategoryIdParamsDto,
  CreateAttributeDto,
  CreateCategoryDto,
  CreateOptionDto,
  OptionIdParamsDto,
  UpdateAttributeDto,
  UpdateCategoryDto,
  UpdateOptionDto,
} from '../dto/category-request.dto';
import {
  toAdminAttributeDto,
  toAdminCategoryNodeDto,
  toAdminCategoryTreeDto,
  toOptionDto,
} from '../dto/category-response.dto';
import { type CategoryAdminService } from '../service/category-admin.service';

/** HTTP only (spec 06 §4.2). Admin-guarded in routes. */
@injectable()
export class CategoryAdminController {
  constructor(@inject(TOKENS.CategoryAdminService) private readonly admin: CategoryAdminService) {}

  tree = async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, HTTP_STATUS.OK, toAdminCategoryTreeDto(await this.admin.getTree()));
  };

  createCategory = async (req: Request, res: Response): Promise<void> => {
    const body = await validateDto(CreateCategoryDto, req.body);
    const id = await this.admin.createCategory(
      { parentId: body.parentId ?? null, name: body.name, slug: body.slug, sortOrder: body.sortOrder },
      actorOf(req),
    );
    sendSuccess(res, HTTP_STATUS.CREATED, toAdminCategoryNodeDto(await this.admin.getTree(), id));
  };

  updateCategory = async (req: Request, res: Response): Promise<void> => {
    const { categoryId } = await validateDto(CategoryIdParamsDto, req.params);
    const { name, slug, sortOrder, isActive } = await validateDto(UpdateCategoryDto, req.body);
    await this.admin.updateCategory(categoryId, { name, slug, sortOrder, isActive }, actorOf(req));
    sendSuccess(res, HTTP_STATUS.OK, toAdminCategoryNodeDto(await this.admin.getTree(), categoryId));
  };

  addAttribute = async (req: Request, res: Response): Promise<void> => {
    const { categoryId } = await validateDto(CategoryIdParamsDto, req.params);
    const { name, code, sortOrder } = await validateDto(CreateAttributeDto, req.body);
    const id = await this.admin.addAttribute(categoryId, { name, code, sortOrder }, actorOf(req));
    sendSuccess(res, HTTP_STATUS.CREATED, toAdminAttributeDto(await this.admin.attributeById(id)));
  };

  updateAttribute = async (req: Request, res: Response): Promise<void> => {
    const { attributeId } = await validateDto(AttributeIdParamsDto, req.params);
    const { name, sortOrder } = await validateDto(UpdateAttributeDto, req.body);
    await this.admin.updateAttribute(attributeId, { name, sortOrder }, actorOf(req));
    sendSuccess(res, HTTP_STATUS.OK, toAdminAttributeDto(await this.admin.attributeById(attributeId)));
  };

  deleteAttribute = async (req: Request, res: Response): Promise<void> => {
    const { attributeId } = await validateDto(AttributeIdParamsDto, req.params);
    await this.admin.deleteAttribute(attributeId, actorOf(req));
    sendNoContent(res);
  };

  addOption = async (req: Request, res: Response): Promise<void> => {
    const { attributeId } = await validateDto(AttributeIdParamsDto, req.params);
    const { value, code, sortOrder } = await validateDto(CreateOptionDto, req.body);
    const id = await this.admin.addOption(attributeId, { value, code, sortOrder }, actorOf(req));
    sendSuccess(res, HTTP_STATUS.CREATED, toOptionDto({ id, attributeId, value, code, sortOrder }));
  };

  updateOption = async (req: Request, res: Response): Promise<void> => {
    const { optionId } = await validateDto(OptionIdParamsDto, req.params);
    const { value, sortOrder } = await validateDto(UpdateOptionDto, req.body);
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      toOptionDto(await this.admin.updateOption(optionId, { value, sortOrder }, actorOf(req))),
    );
  };

  deleteOption = async (req: Request, res: Response): Promise<void> => {
    const { optionId } = await validateDto(OptionIdParamsDto, req.params);
    await this.admin.deleteOption(optionId, actorOf(req));
    sendNoContent(res);
  };
}

function actorOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}
