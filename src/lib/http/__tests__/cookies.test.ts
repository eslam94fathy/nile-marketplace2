import { type Request } from 'express';
import { describe, expect, it } from 'vitest';
import { readCookie } from '../cookies';

const withCookie = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as Request;

describe('readCookie', () => {
  it('finds one cookie among several, trimmed and decoded', () => {
    const req = withCookie('a=1; __Secure-nile_rt=abc%2Ddef ;b=2');
    expect(readCookie(req, '__Secure-nile_rt')).toBe('abc-def');
    expect(readCookie(req, 'b')).toBe('2');
  });

  it('is undefined without a Cookie header or without that name (no prefix matches)', () => {
    expect(readCookie(withCookie(), 'a')).toBeUndefined();
    expect(readCookie(withCookie('ab=1; flag'), 'a')).toBeUndefined();
  });

  it('the first occurrence wins; bad percent-encoding is returned as sent', () => {
    expect(readCookie(withCookie('a=first; a=second'), 'a')).toBe('first');
    expect(readCookie(withCookie('a=%E0%A4%A'), 'a')).toBe('%E0%A4%A');
  });

  it('an empty value is an empty string, not missing', () => {
    expect(readCookie(withCookie('a='), 'a')).toBe('');
  });
});
