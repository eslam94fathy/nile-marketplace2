/** Injected everywhere "now" matters, so time is testable (CLAUDE.md §11). */
export interface IClock {
  now(): Date;
}

export class SystemClock implements IClock {
  now(): Date {
    return new Date();
  }
}
