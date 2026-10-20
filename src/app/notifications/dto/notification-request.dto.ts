import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  ValidateNested,
} from 'class-validator';
import { FieldType, FilterOp, type ListSpec, UuidField } from '../../../lib/http';
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
