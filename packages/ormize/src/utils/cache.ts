export default class Cache {
  store: Record<string, unknown>;
  timeouts: Record<string, ReturnType<typeof setTimeout>>;
  constructor(defaultStore: Record<string, unknown> = {}) {
    this.store = defaultStore;
    this.timeouts = {};
  }
  set = <T>(key: string, value: T, timeout?: number): T => {
    this.store[key] = value;
    if (timeout && timeout > 0) {
      this.clearTimeout(key);
      this.timeouts[key] = setTimeout(() => {
        this.store[key] = undefined;
      }, timeout);
    }
    return this.store[key] as T;
  }
  merge = <T extends Record<string, unknown>>(key: string, value: T, timeout?: number): Record<string, unknown> => {
    const current = (this.store[key] as Record<string, unknown> | undefined) || {};
    return this.set(key, Object.assign(current, value), timeout);
  }
  get = <T = unknown>(key: string, defaultValue?: T): T | undefined => {
    if (!this.store[key]) {
      return defaultValue;
    }
    return this.store[key] as T;
  }
  clearTimeout = (key: string) => {
    if (this.timeouts[key]) {
      clearTimeout(this.timeouts[key]);
    }
  }
}
