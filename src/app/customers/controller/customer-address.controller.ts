import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import { AddressIdParamsDto, CreateAddressDto, UpdateAddressDto } from '../dto/customer-request.dto';
import { toAddressDto } from '../dto/customer-response.dto';
import { type AddressFields } from '../model/customer-address.model';
import { type CustomerAddressService } from '../service/customer-address.service';
import { type CustomerService } from '../service/customer.service';
import { userIdOf } from './customer.controller';

/** HTTP only (spec 04 §4.3). The caller's own addresses, resolved from the token. */
@injectable()
export class CustomerAddressController {
  constructor(
    @inject(TOKENS.CustomerService) private readonly customers: CustomerService,
    @inject(TOKENS.CustomerAddressService) private readonly addresses: CustomerAddressService,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const customerId = await this.customerIdOf(req);
    sendSuccess(res, HTTP_STATUS.OK, (await this.addresses.list(customerId)).map(toAddressDto));
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { addressId } = await validateDto(AddressIdParamsDto, req.params);
    const customerId = await this.customerIdOf(req);
    sendSuccess(res, HTTP_STATUS.OK, toAddressDto(await this.addresses.get(customerId, addressId)));
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const { isDefault, ...dto } = await validateDto(CreateAddressDto, req.body);
    const customerId = await this.customerIdOf(req);
    const fields: AddressFields = {
      ...dto,
      floor: dto.floor ?? null,
      apartment: dto.apartment ?? null,
      landmark: dto.landmark ?? null,
    };
    const address = await this.addresses.create(customerId, fields, isDefault);
    sendSuccess(res, HTTP_STATUS.CREATED, toAddressDto(address));
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { addressId } = await validateDto(AddressIdParamsDto, req.params);
    const { isDefault, ...fields } = await validateDto(UpdateAddressDto, req.body);
    const customerId = await this.customerIdOf(req);
    const address = await this.addresses.update(customerId, addressId, {
      fields,
      ...(isDefault !== undefined ? { isDefault } : {}),
    });
    sendSuccess(res, HTTP_STATUS.OK, toAddressDto(address));
  };

  delete = async (req: Request, res: Response): Promise<void> => {
    const { addressId } = await validateDto(AddressIdParamsDto, req.params);
    await this.addresses.delete(await this.customerIdOf(req), addressId);
    sendNoContent(res);
  };

  private async customerIdOf(req: Request): Promise<string> {
    return (await this.customers.requireByUserId(userIdOf(req))).id;
  }
}
