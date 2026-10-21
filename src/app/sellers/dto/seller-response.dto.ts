import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { IsRate } from '../../../lib/http';
import { UserStatus } from '../../identity';
import { SellerStatus } from '../enums';
import { type PickupAddress, type Seller } from '../model/seller.model';
import { type SellerProfile } from '../service/seller.service';

/* Response DTOs for spec 05 §4.1–§4.3 (decorators describe the OpenAPI shape only). */

export class PickupAddressDto {
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

  // Nullable: always present.
  @IsOptional()
  @IsString()
  landmark!: string | null;
}

export class RegisteredSellerDto {
  @IsUUID()
  userId!: string;

  @IsUUID()
  sellerId!: string;

  @IsEmail()
  email!: string;

  @IsIn([UserStatus.PENDING_EMAIL_VERIFICATION])
  status!: typeof UserStatus.PENDING_EMAIL_VERIFICATION;

  @IsIn([SellerStatus.PENDING_APPROVAL])
  sellerStatus!: typeof SellerStatus.PENDING_APPROVAL;
}

export class SellerProfileDto {
  @IsUUID()
  id!: string;

  @IsEmail()
  email!: string;

  @IsString()
  businessName!: string;

  @IsString()
  contactPhone!: string;

  @ValidateNested()
  @Type(() => PickupAddressDto)
  pickupAddress!: PickupAddressDto;

  @IsIn(Object.values(SellerStatus))
  status!: SellerStatus;

  @IsOptional()
  @IsString()
  rejectionReason!: string | null;

  @IsRate()
  commissionRate!: string;

  @IsOptional()
  @IsISO8601()
  approvedAt!: string | null;

  /** "4.30" over the published reviews of my products; null without any (spec 05 §8.2). */
  @IsOptional()
  @IsString()
  ratingAvg!: string | null;

  @IsInt()
  ratingCount!: number;

  @IsISO8601()
  createdAt!: string;

  @IsISO8601()
  updatedAt!: string;
}

export function toPickupAddressDto(pickup: PickupAddress): PickupAddressDto {
  return { ...pickup };
}

export function toRegisteredSellerDto(registered: {
  userId: string;
  sellerId: string;
  email: string;
}): RegisteredSellerDto {
  return {
    ...registered,
    status: UserStatus.PENDING_EMAIL_VERIFICATION,
    sellerStatus: SellerStatus.PENDING_APPROVAL,
  };
}

export function toSellerProfileDto({ seller, email }: SellerProfile): SellerProfileDto {
  return {
    id: seller.id,
    email,
    businessName: seller.businessName,
    contactPhone: seller.contactPhone,
    pickupAddress: toPickupAddressDto(seller.pickup),
    status: seller.status,
    rejectionReason: seller.rejectionReason,
    commissionRate: seller.commissionRate.toString(),
    approvedAt: seller.approvedAt?.toISOString() ?? null,
    ratingAvg: seller.ratingAvg,
    ratingCount: seller.ratingCount,
    createdAt: seller.createdAt.toISOString(),
    updatedAt: seller.updatedAt.toISOString(),
  };
}

/** `GET /sellers/:sellerId` (spec 05 §8.2): an approved seller's public page. */
export class PublicSellerDto {
  @IsUUID()
  id!: string;

  @IsString()
  businessName!: string;

  @IsOptional()
  @IsString()
  ratingAvg!: string | null;

  @IsInt()
  ratingCount!: number;

  /** When the seller was approved. */
  @IsISO8601()
  memberSince!: string;
}

export function toPublicSellerDto(seller: Seller): PublicSellerDto {
  return {
    id: seller.id,
    businessName: seller.businessName,
    ratingAvg: seller.ratingAvg,
    ratingCount: seller.ratingCount,
    memberSince: (seller.approvedAt ?? seller.createdAt).toISOString(),
  };
}
