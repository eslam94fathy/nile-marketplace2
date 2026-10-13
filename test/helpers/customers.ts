import request from 'supertest';
import { type AuthTokensDto } from '../../src/app/identity/dto/auth-response.dto';
import { successBody } from './http';
import { API, identityFixtures, newEmail, PASSWORD } from './identity';
import { type TestApp } from './test-app';

export const CUSTOMER_PHONE = '+201001234567';

/** Registration body (spec 04 §4.1) with valid defaults. */
export const customerRegistration = (overrides: Record<string, unknown> = {}) => ({
  email: newEmail(),
  password: PASSWORD,
  firstName: 'Mona',
  lastName: 'Ali',
  phone: CUSTOMER_PHONE,
  ...overrides,
});

/** Address body (spec 04 §4.3) with valid defaults. */
export const addressBody = (governorateId: string, overrides: Record<string, unknown> = {}) => ({
  label: 'Home',
  recipientName: 'Mona Ali',
  recipientPhone: CUSTOMER_PHONE,
  governorateId,
  city: 'Cairo',
  area: 'Zamalek',
  street: '26th of July St',
  building: '12',
  isDefault: false,
  ...overrides,
});

export function customerFixtures(t: TestApp) {
  const identity = identityFixtures(t);

  /** Registers over HTTP, verifies the emailed OTP, and returns the logged-in session. */
  async function createActiveCustomer(): Promise<{ userId: string; email: string; accessToken: string }> {
    const body = customerRegistration();
    const res = await request(t.app).post(`${API}/auth/register/customer`).send(body);
    if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
    const { userId } = successBody<{ userId: string }>(res).data;
    const { otp } = await identity.latestSecret(userId, 'email_verification');
    const verified = await request(t.app).post(`${API}/auth/email/verify`).send({ email: body.email, otp });
    if (verified.status !== 200) throw new Error(`verify failed: ${verified.status}`);
    return { userId, email: body.email, accessToken: successBody<AuthTokensDto>(verified).data.accessToken };
  }

  async function governorateId(code: string): Promise<string> {
    const row = await t.infra.db.knex('governorates').select('id').where({ code }).first<{ id: string }>();
    if (!row) throw new Error(`governorate ${code} is not seeded`);
    return row.id;
  }

  return { ...identity, createActiveCustomer, governorateId };
}
