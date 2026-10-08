import { describe, expect, it, vi } from 'vitest';
import { TOKENS } from '../../../lib/di';
import { UserStatus } from '../enums';
import { ADMIN_SUSPENDABLE_ROLES, UserAdminService } from '../service/user-admin.service';
import { createFakes, FAKE_TRX, makeUser } from './fakes';

function setup() {
  const fakes = createFakes();
  const tokens = { revokeAllSessions: vi.fn(() => Promise.resolve(2)) };
  const invitations = { invite: vi.fn(), resendInvite: vi.fn() };
  fakes.container.register(TOKENS.TokenService, { useValue: tokens });
  fakes.container.register(TOKENS.InvitationService, { useValue: invitations });
  return { ...fakes, tokens, service: fakes.container.resolve(UserAdminService) };
}

const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (e: { code?: string }) => e.code,
  );

describe('identity UserAdminService.changeStatus', () => {
  const actor = { actorUserId: 'admin-1' };

  it('suspend: active → suspended only, then every session is revoked', async () => {
    const { service, users, tokens } = setup();
    const user = makeUser();
    users.findById.mockResolvedValue(user);
    users.transitionStatus.mockResolvedValue(makeUser({ id: user.id, status: UserStatus.SUSPENDED }));

    await service.changeStatus(user.id, UserStatus.SUSPENDED, actor, FAKE_TRX);
    expect(users.findById).toHaveBeenCalledWith(user.id, FAKE_TRX, { forUpdate: true });
    expect(users.transitionStatus).toHaveBeenCalledWith(
      user.id,
      [UserStatus.ACTIVE],
      UserStatus.SUSPENDED,
      FAKE_TRX,
    );
    expect(tokens.revokeAllSessions).toHaveBeenCalledWith(user.id, FAKE_TRX);
  });

  it('reactivate: suspended → active only, no session changes', async () => {
    const { service, users, tokens } = setup();
    const user = makeUser({ status: UserStatus.SUSPENDED });
    users.findById.mockResolvedValue(user);
    users.transitionStatus.mockResolvedValue(makeUser());
    await service.changeStatus(user.id, UserStatus.ACTIVE, actor, FAKE_TRX);
    expect(users.transitionStatus).toHaveBeenCalledWith(
      user.id,
      [UserStatus.SUSPENDED],
      UserStatus.ACTIVE,
      FAKE_TRX,
    );
    expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('errors: not found, self-suspension, wrong role, wrong current status', async () => {
    const { service, users, tokens } = setup();
    expect(await errorCode(service.changeStatus('u', UserStatus.SUSPENDED, actor, FAKE_TRX))).toBe(
      'USER_NOT_FOUND',
    );

    users.findById.mockResolvedValue(makeUser({ id: 'admin-1', role: 'admin' }));
    expect(await errorCode(service.changeStatus('admin-1', UserStatus.SUSPENDED, actor, FAKE_TRX))).toBe(
      'CANNOT_SUSPEND_SELF',
    );

    users.findById.mockResolvedValue(makeUser({ role: 'seller' }));
    const restricted = { ...actor, allowedRoles: ADMIN_SUSPENDABLE_ROLES };
    expect(await errorCode(service.changeStatus('u', UserStatus.SUSPENDED, restricted, FAKE_TRX))).toBe(
      'USER_INVALID_STATUS_TRANSITION',
    );

    users.findById.mockResolvedValue(makeUser({ role: 'delivery_agent' }));
    users.transitionStatus.mockResolvedValue(undefined);
    expect(await errorCode(service.changeStatus('u', UserStatus.SUSPENDED, actor, FAKE_TRX))).toBe(
      'USER_INVALID_STATUS_TRANSITION',
    );
    expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('setUserStatus path (no role restriction) suspends a delivery agent (S-10)', async () => {
    const { service, users } = setup();
    users.findById.mockResolvedValue(makeUser({ role: 'delivery_agent' }));
    users.transitionStatus.mockResolvedValue(
      makeUser({ role: 'delivery_agent', status: UserStatus.SUSPENDED }),
    );
    const updated = await service.changeStatus('u', UserStatus.SUSPENDED, actor, FAKE_TRX);
    expect(updated.status).toBe(UserStatus.SUSPENDED);
  });
});
