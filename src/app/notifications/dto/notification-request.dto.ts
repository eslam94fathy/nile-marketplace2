import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsString,
  IsUrl,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import {
  FieldType,
  FilterOp,
  type ListSpec,
  Nullable,
  Optional,
  StrField,
  UuidField,
} from '../../../lib/http';
import {
  PUSH_AUTH_MAX_LENGTH,
  PUSH_ENDPOINT_MAX_LENGTH,
  PUSH_P256DH_MAX_LENGTH,
  PUSH_USER_AGENT_MAX_LENGTH,
} from '../constants';
import { NotificationCategory } from '../enums';

const CATEGORIES = Object.values(NotificationCategory);

export class NotificationIdParamsDto {
  @UuidField()
  notificationId!: string;
}

/**
 * Spec 13 §8.4 whitelist for `GET /me/notifications`. `read` has no column: the repository filters on
 * `read_at` (custom field).
 */
export const NOTIFICATION_LIST_SPEC: ListSpec = {
  fields: {
    read: { type: FieldType.BOOLEAN, ops: [FilterOp.EQ] },
    category: {
      column: 'category',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: CATEGORIES,
    },
    createdAt: { column: 'created_at', type: FieldType.DATE, ops: [], sortable: true },
  },
  defaultSort: '-createdAt',
};

export class PreferenceDto {
  @IsIn(CATEGORIES)
  category!: NotificationCategory;

  @IsBoolean()
  pushEnabled!: boolean;
}

export class UpdatePreferencesDto {
  /** The categories to change, each at most once; the others keep their value. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CATEGORIES.length)
  @ArrayUnique((preference: PreferenceDto) => preference.category)
  @ValidateNested({ each: true })
  @Type(() => PreferenceDto)
  preferences!: PreferenceDto[];
}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export class PushKeysDto {
  @IsString()
  @Length(1, PUSH_P256DH_MAX_LENGTH)
  @Matches(BASE64URL)
  p256dh!: string;

  @IsString()
  @Length(1, PUSH_AUTH_MAX_LENGTH)
  @Matches(BASE64URL)
  auth!: string;
}

/** `PushSubscription.toJSON()` from the browser, plus an optional device label (spec 13 §8.4). */
export class RegisterPushSubscriptionDto {
  @IsString()
  @Length(1, PUSH_ENDPOINT_MAX_LENGTH)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: true })
  endpoint!: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;

  /** Part of `toJSON()`; accepted and ignored, so the client can post it as is (NO-23). */
  @Optional()
  @Nullable()
  @IsNumber()
  expirationTime?: number | null;

  @Optional()
  @StrField(1, PUSH_USER_AGENT_MAX_LENGTH)
  userAgent?: string;
}

export class UnregisterPushSubscriptionDto {
  @IsString()
  @Length(1, PUSH_ENDPOINT_MAX_LENGTH)
  endpoint!: string;
}
