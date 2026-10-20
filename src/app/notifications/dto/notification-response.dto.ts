import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator';
import { NotificationCategory, NotificationType } from '../enums';
import { type NotificationPreference, type UserNotification } from '../model/user-notification.model';

/* Response DTOs for spec 13 §8.4 (decorators describe the OpenAPI shape only). */

export class UserNotificationDto {
  @IsUUID()
  id!: string;

  @IsIn(Object.values(NotificationCategory))
  category!: NotificationCategory;

  @IsIn(Object.values(NotificationType))
  type!: NotificationType;

  @IsString()
  title!: string;

  @IsString()
  body!: string;

  // Nullable: a client route such as /orders/<id>, null when there is nothing to open.
  @IsOptional()
  @IsString()
  link!: string | null;

  @IsBoolean()
  read!: boolean;

  @IsISO8601()
  createdAt!: string;
}

export class UnreadCountDto {
  /** Counted up to 100: show "99+" from there. */
  @IsInt()
  count!: number;
}

export class NotificationPreferenceDto {
  @IsIn(Object.values(NotificationCategory))
  category!: NotificationCategory;

  @IsBoolean()
  pushEnabled!: boolean;
}

export function toUserNotificationDto(n: UserNotification): UserNotificationDto {
  return {
    id: n.id,
    category: n.category,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    read: n.readAt !== null,
    createdAt: n.createdAt.toISOString(),
  };
}

export const toNotificationPreferenceDto = (p: NotificationPreference): NotificationPreferenceDto => ({
  category: p.category,
  pushEnabled: p.pushEnabled,
});
