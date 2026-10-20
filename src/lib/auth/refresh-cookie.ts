/**
 * The web client's refresh-token transport (spec 03 §8.1, R-21). Native clients keep the body
 * transport; a request opts in with `X-Nile-Client: web`.
 */
export const REFRESH_COOKIE = {
  /** `__Secure-`: browsers only accept it with `Secure` (CLAUDE.md §10). */
  NAME: '__Secure-nile_rt',
  /** Only the auth endpoints receive it: `${API_BASE_PATH}/auth`. */
  PATH: '/api/v1/auth',
} as const;

/** The value of `X-Nile-Client` that selects the cookie transport. */
export const WEB_CLIENT = 'web';
