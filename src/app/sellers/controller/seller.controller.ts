import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, sendSuccess, validateDto } from '../../../lib/http';
import {
  type PickupAddressInput,
  RegisterSellerDto,
  UpdateSellerProfileDto,
} from '../dto/seller-request.dto';
import { toRegisteredSellerDto, toSellerProfileDto } from '../dto/seller-response.dto';
import { type PickupAddress } from '../model/seller.model';
import { type SellerService } from '../service/seller.service';

/** HTTP only (spec 05 §4.2, §4.3). */
@injectable()
export class SellerController {
  constructor(@inject(TOKENS.SellerService) private readonly sellers: SellerService) {}

  register = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(RegisterSellerDto, req.body);
    const registered = await this.sellers.register({
      email: dto.email,
      password: dto.password,
      businessName: dto.businessName,
      contactPhone: dto.contactPhone,
      pickup: toPickup(dto.pickupAddress),
    });
    sendSuccess(res, HTTP_STATUS.CREATED, toRegisteredSellerDto(registered));
  };

  getProfile = async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, HTTP_STATUS.OK, toSellerProfileDto(await this.sellers.getProfile(userIdOf(req))));
  };

  updateProfile = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(UpdateSellerProfileDto, req.body);
    const profile = await this.sellers.updateProfile(userIdOf(req), {
      businessName: dto.businessName,
      contactPhone: dto.contactPhone,
      pickup: dto.pickupAddress ? toPickup(dto.pickupAddress) : undefined,
    });
    sendSuccess(res, HTTP_STATUS.OK, toSellerProfileDto(profile));
  };

  reapply = async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, HTTP_STATUS.OK, toSellerProfileDto(await this.sellers.reapply(userIdOf(req))));
  };
}

function toPickup(input: PickupAddressInput): PickupAddress {
  return {
    governorateId: input.governorateId,
    city: input.city,
    area: input.area,
    street: input.street,
    building: input.building,
    landmark: input.landmark ?? null,
  };
}

function userIdOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}
