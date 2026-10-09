import { IsBoolean, IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator';
import { IsMoney, IsRate } from '../../../lib/http';
import { type DeliverySettings } from '../model/delivery-settings.model';
import { type Governorate } from '../model/governorate.model';

/* Response DTOs for spec 11 §4.1 and §4.3 (decorators describe the OpenAPI shape only). */

export class GovernorateDto {
  @IsUUID()
  id!: string;

  /** ISO 3166-2:EG; the app localizes the name by it. */
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  // Nullable: present in every item, null = not deliverable.
  @IsOptional()
  @IsMoney()
  deliveryFee!: string | null;

  @IsBoolean()
  isDeliverable!: boolean;
}

export class DeliverySettingsDto {
  @IsRate()
  agentFeeShareRate!: string;

  @IsISO8601()
  updatedAt!: string;
}

export function toGovernorateDto(governorate: Governorate): GovernorateDto {
  return {
    id: governorate.id,
    code: governorate.code,
    name: governorate.name,
    deliveryFee: governorate.deliveryFee?.toString() ?? null,
    isDeliverable: governorate.isDeliverable,
  };
}

export function toDeliverySettingsDto(settings: DeliverySettings): DeliverySettingsDto {
  return {
    agentFeeShareRate: settings.agentFeeShareRate.toString(),
    updatedAt: settings.updatedAt.toISOString(),
  };
}
