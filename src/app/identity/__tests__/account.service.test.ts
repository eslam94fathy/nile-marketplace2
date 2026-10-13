import { describe, expect, it, vi } from 'vitest';
import { TOKENS } from '../../../lib/di';
import { UserStatus } from '../enums';
import { AccountService, type PasswordHash } from '../service/account.service';
import { createFakes, FAKE_TRX, makeUser, NOW } from './fakes';

function setup() {
  const fakes = createFakes();
  const users = {
    ...fakes.users,
    insert: vi.fn(() => Promise.resolve(makeUser({ status: UserStatus.PENDING_EMAIL_VERIFICATION }))),
  };
  const codes = { issueOtp: vi.fn(() => Promise.resolve({ otp: '123456', expiresAt: NOW })) };
  const notifier = { requestOtpEmail: vi.fn(() => Promise.resolve()) };
  fakes.container.register(TOKENS.UserRepository, { useValue: users });
  fakes.container.register(TOKENS.VerificationCodeService, { useValue: codes });
  fakes.container.register(TOKENS.IdentityEmailNotifier, { useValue: notifier });
  fakes.container.register(TOKENS.InvitationService, { useValue: {} });
  fakes.container.register(TOKENS.UserAdminService, { useValue: {} });
  return { ...fakes, users, codes, notifier, service: fakes.container.resolve(AccountService) };
}

describe('identity AccountService', () => {
  it('hashPassword uses the configured hasher', async () => {
    const { service, hasher } = setup();

    await expect(service.hashPassword('a password')).resolves.toBe('hash:a password');
    expect(hasher.hash).toHaveBeenCalledWith('a password');
  });

  // Regression (P2-Q2, spec 03 I-10): bcrypt must not run while the caller's transaction is open.
  it('createPendingUser stores the given hash and never hashes inside the transaction', async () => {
    const { service, hasher, users, codes, notifier } = setup();

    await service.createPendingUser(
      { email: 'new@example.com', passwordHash: 'hash:pw' as PasswordHash, role: 'customer' },
      FAKE_TRX,
    );

    expect(hasher.hash).not.toHaveBeenCalled();
    expect(users.insert).toHaveBeenCalledWith(
      {
        email: 'new@example.com',
        passwordHash: 'hash:pw',
        role: 'customer',
        status: UserStatus.PENDING_EMAIL_VERIFICATION,
      },
      FAKE_TRX,
    );
    expect(codes.issueOtp).toHaveBeenCalledWith(expect.any(String), 'email_verification', FAKE_TRX);
    expect(notifier.requestOtpEmail).toHaveBeenCalledOnce();
  });
});
