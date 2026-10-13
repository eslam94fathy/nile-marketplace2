/** Key-value cache / lock store. Not a source of truth: callers must survive its loss. */
export interface ICache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Atomic `SET NX EX`: true if the key was created (used as a lock). */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  delete(...keys: string[]): Promise<number>;
  ping(): Promise<void>;
}
