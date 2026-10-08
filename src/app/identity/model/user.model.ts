import { type UserRole } from '../../../lib/auth';
import { UserStatus } from '../enums';

export interface UserProps {
  id: string;
  email: string;
  passwordHash: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class User {
  constructor(private readonly props: UserProps) {}

  get id(): string {
    return this.props.id;
  }
  get email(): string {
    return this.props.email;
  }
  get passwordHash(): string | null {
    return this.props.passwordHash;
  }
  get role(): UserRole {
    return this.props.role;
  }
  get status(): UserStatus {
    return this.props.status;
  }
  get emailVerifiedAt(): Date | null {
    return this.props.emailVerifiedAt;
  }
  get lastLoginAt(): Date | null {
    return this.props.lastLoginAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  isActive(): boolean {
    return this.props.status === UserStatus.ACTIVE;
  }

  isInvited(): boolean {
    return this.props.status === UserStatus.INVITED;
  }

  isPendingEmailVerification(): boolean {
    return this.props.status === UserStatus.PENDING_EMAIL_VERIFICATION;
  }

  isSuspended(): boolean {
    return this.props.status === UserStatus.SUSPENDED;
  }
}
