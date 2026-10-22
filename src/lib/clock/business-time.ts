/**
 * The business day's time zone (spec 20 §3.1, BO-5): daily figures count `[00:00, 24:00)` Cairo time,
 * computed in SQL with `AT TIME ZONE`. Stored data stays UTC.
 */
export const BUSINESS_TIME_ZONE = 'Africa/Cairo';
