import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, sendSuccess, validateDto } from '../../../lib/http';
import { RegisterCustomerDto, UpdateCustomerProfileDto } from '../dto/customer-request.dto';
import { toCustomerProfileDto, toRegisteredCustomerDto } from '../dto/customer-response.dto';
import { type CustomerService } from '../service/customer.service';

/** HTTP only (spec 04 §4.1, §4.2). */
@injectable()
export class CustomerController {
  constructor(@inject(TOKENS.CustomerService) private readonly customers: CustomerService) {}

  register = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(RegisterCustomerDto, req.body);
    const registered = await this.customers.register(dto);
    sendSuccess(res, HTTP_STATUS.CREATED, toRegisteredCustomerDto(registered));
  };

  getProfile = async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, HTTP_STATUS.OK, toCustomerProfileDto(await this.customers.getProfile(userIdOf(req))));
  };

  updateProfile = async (req: Request, res: Response): Promise<void> => {
    const { firstName, lastName, phone } = await validateDto(UpdateCustomerProfileDto, req.body);
    const profile = await this.customers.updateProfile(userIdOf(req), { firstName, lastName, phone });
    sendSuccess(res, HTTP_STATUS.OK, toCustomerProfileDto(profile));
  };
}

export function userIdOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}
