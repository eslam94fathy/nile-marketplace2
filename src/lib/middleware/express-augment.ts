import { type AuthContext } from '../auth/jwt-verifier';

declare global {
  // Express merges its Request type through this namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `authenticate` after the access token is verified. */
      auth?: AuthContext;
    }
  }
}

export {};
