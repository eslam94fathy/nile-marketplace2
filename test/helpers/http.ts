import { type Response } from 'supertest';
import { type ErrorEnvelope, type SuccessEnvelope } from '../../src/lib/http';

/** Supertest types `body` as `any`; tests read it through these typed views. */
export function errorBody(res: Response): ErrorEnvelope {
  return res.body as ErrorEnvelope;
}

export function successBody<T>(res: Response): SuccessEnvelope<T> {
  return res.body as SuccessEnvelope<T>;
}
