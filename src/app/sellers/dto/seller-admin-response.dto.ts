import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { IsRate } from '../../../lib/http';
import { SellerStatus } from '../enums';
import { type SellerSettings } from '../repository/seller-settings.repository';
import { type AdminSellerDetail, type AdminSellerListItem } from '../service/seller-admin.service';
import { PickupAddressDto, toPickupAddressDto } from './seller-response.dto';

/* Response DTOs for spec 05 §4.4 (decorators describe the OpenAPI shape only). */

export class AdminSellerListItemDto {
  @IsUUID()
  id!: string;

  @IsString()
  businessName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  contactPhone!: string;

  @IsIn(Object.values(SellerStatus))
  status!: SellerStatus;

  @IsRate()
  commissionRate!: string;

  @IsUUID()
  pickupGovernorateId!: string;

  @IsISO8601()
  createdAt!: string;

  // Nullable: present in every item, null until the first approval.
  @IsOptional()
  @IsISO8601()
  approvedAt!: string | null;
}

export class SellerStatusHistoryEntryDto {
  // Nullable: null for the registration entry.
  @IsOptional()
  @IsIn(Object.values(SellerStatus))
  fromStatus!: SellerStatus | null;

  @IsIn(Object.values(SellerStatus))
  toStatus!: SellerStatus;

  @IsOptional()
  @IsString()
  reason!: string | null;

  // Nullable: null = system.
  @IsOptional()
  @IsUUID()
  actorUserId!: string | null;

  @IsISO8601()
  createdAt!: string;
}

export class SellerCommissionHistoryEntryDto {
  @IsRate()
  oldRate!: string;

  @IsRate()
  newRate!: string;

  @IsUUID()
  changedByUserId!: string;

  @IsISO8601()
  createdAt!: string;
}

export class AdminSellerDetailDto extends AdminSellerListItemDto {
  @ValidateNested()
  @Type(() => PickupAddressDto)
  pickupAddress!: PickupAddressDto;

  @IsOptional()
  @IsString()
  rejectionReason!: string | null;

  @IsBoolean()
  emailVerified!: boolean;

  /** Newest first, last 50. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SellerStatusHistoryEntryDto)
  statusHistory!: SellerStatusHistoryEntryDto[];

  /** Newest first, last 50. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SellerCommissionHistoryEntryDto)
  commissionHistory!: SellerCommissionHistoryEntryDto[];
}

export class CommissionSettingsDto {
  @IsRate()
  defaultCommissionRate!: string;

  @IsISO8601()
  updatedAt!: string;
}

export function toAdminSellerListItemDto({ seller, email }: AdminSellerListItem): AdminSellerListItemDto {
  return {
    id: seller.id,
    businessName: seller.businessName,
    email,
    contactPhone: seller.contactPhone,
    status: seller.status,
    commissionRate: seller.commissionRate.toString(),
    pickupGovernorateId: seller.pickup.governorateId,
    createdAt: seller.createdAt.toISOString(),
    approvedAt: seller.approvedAt?.toISOString() ?? null,
  };
}

export function toAdminSellerDetailDto(detail: AdminSellerDetail): AdminSellerDetailDto {
  return {
    ...toAdminSellerListItemDto(detail),
    pickupAddress: toPickupAddressDto(detail.seller.pickup),
    rejectionReason: detail.seller.rejectionReason,
    emailVerified: detail.emailVerified,
    statusHistory: detail.statusHistory.map((entry) => ({
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      reason: entry.reason,
      actorUserId: entry.actorUserId,
      createdAt: entry.createdAt.toISOString(),
    })),
    commissionHistory: detail.commissionHistory.map((entry) => ({
      oldRate: entry.oldRate.toString(),
      newRate: entry.newRate.toString(),
      changedByUserId: entry.changedByUserId,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

export function toCommissionSettingsDto(settings: SellerSettings): CommissionSettingsDto {
  return {
    defaultCommissionRate: settings.defaultCommissionRate.toString(),
    updatedAt: settings.updatedAt.toISOString(),
  };
}
