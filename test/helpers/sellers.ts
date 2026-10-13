import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type AuthTokensDto } from '../../src/app/identity/dto/auth-response.dto';
import { type RegisteredSellerDto } from '../../src/app/sellers/dto/seller-response.dto';
import { customerFixtures } from './customers';
import { successBody } from './http';
import { API, newEmail, PASSWORD } from './identity';
import { type TestApp } from './test-app';

export const SELLER_PHONE = '+201221234567';

/** Unique per call: business names are unique case-insensitively. */
export const newBusinessName = (): string => `Shop ${randomUUID().slice(0, 8)}`;

/** Registration body (spec 05 §4.2) with valid defaults. */
export const sellerRegistration = (governorateId: string, overrides: Record<string, unknown> = {}) => ({
  email: newEmail(),
  password: PASSWORD,
  businessName: newBusinessName(),
  contactPhone: SELLER_PHONE,
  pickupAddress: {
    governorateId,
    city: 'Cairo',
    area: 'Nasr City',
    street: 'Abbas El Akkad St',
    building: '5',
  },
  ...overrides,
});

export interface ActiveSeller {
  userId: string;
  sellerId: string;
  email: string;
  businessName: string;
  accessToken: string;
}

export function sellerFixtures(t: TestApp) {
  const base = customerFixtures(t);

  /** Registers over HTTP and verifies the emailed OTP; the seller stays `pending_approval`. */
  async function createVerifiedSeller(overrides: Record<string, unknown> = {}): Promise<ActiveSeller> {
    const body = sellerRegistration(await base.governorateId('EG-C'), overrides);
    const res = await request(t.app).post(`${API}/auth/register/seller`).send(body);
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    const { userId, sellerId } = successBody<RegisteredSellerDto>(res).data;
    const { otp } = await base.latestSecret(userId, 'email_verification');
    const verified = await request(t.app).post(`${API}/auth/email/verify`).send({ email: body.email, otp });
    if (verified.status !== 200) throw new Error(`verify failed: ${verified.status}`);
    return {
      userId,
      sellerId,
      email: body.email,
      businessName: body.businessName,
      accessToken: successBody<AuthTokensDto>(verified).data.accessToken,
    };
  }

  return { ...base, createVerifiedSeller };
}
