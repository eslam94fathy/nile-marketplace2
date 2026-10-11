import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, type HttpStatus, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import { type ICustomerDirectory } from '../../customers';
import { AddCartItemDto, CartItemIdParamsDto, UpdateCartItemDto } from '../dto/cart-request.dto';
import { toCartDto } from '../dto/cart-response.dto';
import { customerProfileMissing } from '../errors';
import { type CartViewService } from '../service/cart-view.service';
import { type CartService } from '../service/cart.service';

/**
 * HTTP only (spec 08 §4). The caller's own cart, resolved from the token. Writes answer with the
 * whole cart, built after the write committed.
 */
@injectable()
export class CartController {
  constructor(
    @inject(TOKENS.CartService) private readonly cart: CartService,
    @inject(TOKENS.CartViewService) private readonly views: CartViewService,
    @inject(TOKENS.CustomerDirectory) private readonly customers: ICustomerDirectory,
  ) {}

  get = async (req: Request, res: Response): Promise<void> => {
    await this.sendCart(res, HTTP_STATUS.OK, await this.customerIdOf(req));
  };

  addItem = async (req: Request, res: Response): Promise<void> => {
    const { variantId, quantity } = await validateDto(AddCartItemDto, req.body);
    const customerId = await this.customerIdOf(req);
    await this.cart.addItem(customerId, variantId, quantity);
    await this.sendCart(res, HTTP_STATUS.CREATED, customerId);
  };

  updateItem = async (req: Request, res: Response): Promise<void> => {
    const { itemId } = await validateDto(CartItemIdParamsDto, req.params);
    const { quantity } = await validateDto(UpdateCartItemDto, req.body);
    const customerId = await this.customerIdOf(req);
    await this.cart.changeQuantity(customerId, itemId, quantity);
    await this.sendCart(res, HTTP_STATUS.OK, customerId);
  };

  removeItem = async (req: Request, res: Response): Promise<void> => {
    const { itemId } = await validateDto(CartItemIdParamsDto, req.params);
    await this.cart.removeItem(await this.customerIdOf(req), itemId);
    sendNoContent(res);
  };

  clear = async (req: Request, res: Response): Promise<void> => {
    await this.cart.clear(await this.customerIdOf(req));
    sendNoContent(res);
  };

  private async sendCart(res: Response, status: HttpStatus, customerId: string): Promise<void> {
    sendSuccess(res, status, toCartDto(await this.views.get(customerId)));
  }

  /** The route already required the customer role, so a missing profile is a bug (CT-8). */
  private async customerIdOf(req: Request): Promise<string> {
    if (!req.auth) throw unauthenticated();
    const customerId = await this.customers.getCustomerIdByUserId(req.auth.userId);
    if (customerId === null) throw customerProfileMissing(req.auth.userId);
    return customerId;
  }
}
