import { IsString, IsUUID } from 'class-validator';
import { IsMoney, IsRate, Nullable } from '../../../lib/http';

/** Request DTOs for spec 11 §4.3 (reference data part). */

export class GovernorateIdParamsDto {
  @IsUUID('7')
  governorateId!: string;
}

/** `deliveryFee nullable money`: null makes the governorate non-deliverable (Q-26). */
export class UpdateGovernorateDto {
  @Nullable()
  @IsString()
  @IsMoney()
  deliveryFee!: string | null;
}

export class UpdateDeliverySettingsDto {
  @IsString()
  @IsRate()
  agentFeeShareRate!: string;
}
