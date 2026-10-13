import { Type } from 'class-transformer';
import { IsObject, ValidateNested } from 'class-validator';
import {
  EmailField,
  Nullable,
  Optional,
  PasswordField,
  PatchDto,
  PhoneField,
  StrField,
  UuidField,
} from '../../../lib/http';
import { BUSINESS_NAME_MAX_LENGTH, BUSINESS_NAME_MIN_LENGTH, PICKUP_LIMITS as L } from '../constants';

/** Request DTOs for spec 05 §4.1–§4.3. Notation: docs/spec/01-api-conventions.md §1.1. */

export class PickupAddressInput {
  @UuidField()
  governorateId!: string;

  @StrField(1, L.CITY)
  city!: string;

  @StrField(1, L.AREA)
  area!: string;

  @StrField(1, L.STREET)
  street!: string;

  @StrField(1, L.BUILDING)
  building!: string;

  @Optional()
  @Nullable()
  @StrField(1, L.LANDMARK)
  landmark?: string | null;
}

export class RegisterSellerDto {
  @EmailField()
  email!: string;

  @PasswordField()
  password!: string;

  @StrField(BUSINESS_NAME_MIN_LENGTH, BUSINESS_NAME_MAX_LENGTH)
  businessName!: string;

  @PhoneField()
  contactPhone!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => PickupAddressInput)
  pickupAddress!: PickupAddressInput;
}

/** At least one field. `pickupAddress` replaces the whole address. */
export class UpdateSellerProfileDto extends PatchDto {
  @Optional()
  @StrField(BUSINESS_NAME_MIN_LENGTH, BUSINESS_NAME_MAX_LENGTH)
  businessName?: string;

  @Optional()
  @PhoneField()
  contactPhone?: string;

  @Optional()
  @IsObject()
  @ValidateNested()
  @Type(() => PickupAddressInput)
  pickupAddress?: PickupAddressInput;
}
