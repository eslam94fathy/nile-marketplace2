import { IsString, IsUUID, Length } from 'class-validator';
import { EmailField, FieldType, FilterOp, type FieldSpec, type ListSpec, Trim } from '../../../lib/http';
import { UserRole } from '../../../lib/auth';
import { SUSPEND_REASON_MAX_LENGTH, SUSPEND_REASON_MIN_LENGTH, USER_LIST_PARAMS } from '../constants';
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

const STATUS_FIELD: FieldSpec = {
  column: 'status',
  type: FieldType.ENUM,
  ops: [FilterOp.EQ, FilterOp.IN],
  enumValues: Object.values(UserStatus),
};

const CREATED_AT_FIELD: FieldSpec = {
  column: 'created_at',
  type: FieldType.DATE,
  ops: [FilterOp.GTE, FilterOp.LTE],
  sortable: true,
};

/** §4.11 whitelist. */
export const ADMIN_LIST_SPEC: ListSpec = {
  fields: { status: STATUS_FIELD, createdAt: CREATED_AT_FIELD },
  defaultSort: '-createdAt',
};

/**
 * Spec 20 §3.3 whitelist (BO-17). `email[like]` is a prefix match, applied by the repository so it can
 * use `idx_users_email_pattern` (the generic `like` is a contains match no index serves).
 */
export const USER_LIST_SPEC: ListSpec = {
  fields: {
    role: {
      column: 'role',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ],
      enumValues: Object.values(UserRole),
    },
    status: STATUS_FIELD,
    [USER_LIST_PARAMS.EMAIL]: { type: FieldType.TEXT, ops: [FilterOp.LIKE] },
    createdAt: CREATED_AT_FIELD,
  },
  defaultSort: '-createdAt',
};
