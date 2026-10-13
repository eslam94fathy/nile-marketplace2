import { IsBoolean } from 'class-validator';
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
import { ADDRESS_LIMITS as L, NAME_MAX_LENGTH } from '../constants';

/** Request DTOs for spec 04 §4. Notation: docs/spec/01-api-conventions.md §1.1. */

export class RegisterCustomerDto {
  @EmailField()
  email!: string;

  @PasswordField()
  password!: string;

  @StrField(1, NAME_MAX_LENGTH)
  firstName!: string;

  @StrField(1, NAME_MAX_LENGTH)
  lastName!: string;

  @PhoneField()
  phone!: string;
}

/** Email can't be changed in R1. */
export class UpdateCustomerProfileDto extends PatchDto {
  @Optional()
  @StrField(1, NAME_MAX_LENGTH)
  firstName?: string;

  @Optional()
  @StrField(1, NAME_MAX_LENGTH)
  lastName?: string;

  @Optional()
  @PhoneField()
  phone?: string;
}

export class AddressIdParamsDto {
  @UuidField()
  addressId!: string;
}

export class CreateAddressDto {
  @StrField(1, L.LABEL)
  label!: string;

  @StrField(1, L.RECIPIENT_NAME)
  recipientName!: string;

  @PhoneField()
  recipientPhone!: string;

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
  @StrField(1, L.FLOOR)
  floor?: string | null;

  @Optional()
  @Nullable()
  @StrField(1, L.APARTMENT)
  apartment?: string | null;

  @Optional()
  @Nullable()
  @StrField(1, L.LANDMARK)
  landmark?: string | null;

  @IsBoolean()
  isDefault!: boolean;
}

/** Same fields, all optional, at least one. `null` clears floor / apartment / landmark. */
export class UpdateAddressDto extends PatchDto {
  @Optional()
  @StrField(1, L.LABEL)
  label?: string;

  @Optional()
  @StrField(1, L.RECIPIENT_NAME)
  recipientName?: string;

  @Optional()
  @PhoneField()
  recipientPhone?: string;

  @Optional()
  @UuidField()
  governorateId?: string;

  @Optional()
  @StrField(1, L.CITY)
  city?: string;

  @Optional()
  @StrField(1, L.AREA)
  area?: string;

  @Optional()
  @StrField(1, L.STREET)
  street?: string;

  @Optional()
  @StrField(1, L.BUILDING)
  building?: string;

  @Optional()
  @Nullable()
  @StrField(1, L.FLOOR)
  floor?: string | null;

  @Optional()
  @Nullable()
  @StrField(1, L.APARTMENT)
  apartment?: string | null;

  @Optional()
  @Nullable()
  @StrField(1, L.LANDMARK)
  landmark?: string | null;

  @Optional()
  @IsBoolean()
  isDefault?: boolean;
}
