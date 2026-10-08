import { type VerificationPurpose } from '../enums';

export interface VerificationCodeProps {
  id: string;
  userId: string;
  purpose: VerificationPurpose;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
}

export class VerificationCode {
  constructor(private readonly props: VerificationCodeProps) {}

  get id(): string {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get purpose(): VerificationPurpose {
    return this.props.purpose;
  }
  get codeHash(): string {
    return this.props.codeHash;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get attempts(): number {
    return this.props.attempts;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  /** Usable = not consumed, not expired, attempts left. */
  isUsable(now: Date, maxAttempts: number): boolean {
    return (
      this.props.consumedAt === null &&
      this.props.expiresAt.getTime() > now.getTime() &&
      this.props.attempts < maxAttempts
    );
  }
}
