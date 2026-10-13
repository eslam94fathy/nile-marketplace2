import { IsBoolean, IsEmail, IsIn, IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator';
import { UserStatus } from '../../identity';
import { type CustomerAddress } from '../model/customer-address.model';
import { type CustomerProfile } from '../service/customer.service';

/* Response DTOs for spec 04 §4 (decorators describe the OpenAPI shape only). */

export class RegisteredCustomerDto {
  @IsUUID()
  userId!: string;

  @IsEmail()
  email!: string;

  @IsIn([UserStatus.PENDING_EMAIL_VERIFICATION])
  status!: typeof UserStatus.PENDING_EMAIL_VERIFICATION;
}

export class CustomerProfileDto {
  @IsUUID()
  id!: string;

  @IsEmail()
  email!: string;

  @IsString()
  firstName!: string;

  @IsString()
  lastName!: string;

  @IsString()
  phone!: string;

  @IsISO8601()
  createdAt!: string;
}

export class AddressDto {
  @IsUUID()
  id!: string;

  @IsString()
  label!: string;

  @IsString()
  recipientName!: string;

  @IsString()
  recipientPhone!: string;

  @IsUUID()
  governorateId!: string;

  @IsString()
  city!: string;

  @IsString()
  area!: string;

  @IsString()
  street!: string;

  @IsString()
  building!: string;

  // Nullable: present in every item.
  @IsOptional()
  @IsString()
  floor!: string | null;

  @IsOptional()
  @IsString()
  apartment!: string | null;

  @IsOptional()
  @IsString()
  landmark!: string | null;

  @IsBoolean()
  isDefault!: boolean;

  @IsISO8601()
  createdAt!: string;

  @IsISO8601()
  updatedAt!: string;
}

export function toRegisteredCustomerDto(registered: {
  userId: string;
  email: string;
}): RegisteredCustomerDto {
  return { ...registered, status: UserStatus.PENDING_EMAIL_VERIFICATION };
}

export function toCustomerProfileDto({ customer, email }: CustomerProfile): CustomerProfileDto {
  return {
    id: customer.id,
    email,
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone,
    createdAt: customer.createdAt.toISOString(),
  };
}

export function toAddressDto(address: CustomerAddress): AddressDto {
  return {
    id: address.id,
    ...address.fields,
    isDefault: address.isDefault,
    createdAt: address.createdAt.toISOString(),
    updatedAt: address.updatedAt.toISOString(),
  };
}
