import { IsEmail, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { FieldType, FilterOp, type ListSpec, NormalizeEmail, Trim } from '../../../lib/http';
import { EMAIL_MAX_LENGTH, SUSPEND_REASON_MAX_LENGTH, SUSPEND_REASON_MIN_LENGTH } from '../constants';
import { UserStatus } from '../enums';

/** Request DTOs for spec 03 §4.10–§4.13. */

export class InviteAdminDto {
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;
}

export class UserIdParamsDto {
  @IsUUID('7')
  userId!: string;
}

export class SuspendUserDto {
  @Trim()
  @IsString()
  @Length(SUSPEND_REASON_MIN_LENGTH, SUSPEND_REASON_MAX_LENGTH)
  reason!: string;
}

/** §4.11 whitelist. */
export const ADMIN_LIST_SPEC: ListSpec = {
  fields: {
    status: {
      column: 'status',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: Object.values(UserStatus),
    },
    createdAt: {
      column: 'created_at',
      type: FieldType.DATE,
      ops: [FilterOp.GTE, FilterOp.LTE],
      sortable: true,
    },
  },
  defaultSort: '-createdAt',
};
