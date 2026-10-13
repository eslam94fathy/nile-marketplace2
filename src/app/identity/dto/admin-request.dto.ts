import { IsString, IsUUID, Length } from 'class-validator';
import { EmailField, FieldType, FilterOp, type ListSpec, Trim } from '../../../lib/http';
import { SUSPEND_REASON_MAX_LENGTH, SUSPEND_REASON_MIN_LENGTH } from '../constants';
import { UserStatus } from '../enums';

/** Request DTOs for spec 03 §4.10–§4.13. */

export class InviteAdminDto {
  @EmailField()
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
