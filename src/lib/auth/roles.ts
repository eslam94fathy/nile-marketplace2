/** Shared kernel roles (docs/spec/01-api-conventions.md §8). One role per account. */
export const UserRole = {
  CUSTOMER: 'customer',
  SELLER: 'seller',
  ADMIN: 'admin',
  DELIVERY_AGENT: 'delivery_agent',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** Who did something, in status histories. */
export const ActorRole = { ...UserRole, SYSTEM: 'system' } as const;
export type ActorRole = (typeof ActorRole)[keyof typeof ActorRole];

const ROLES: ReadonlySet<string> = new Set(Object.values(UserRole));

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && ROLES.has(value);
}
