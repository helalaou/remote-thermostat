// In-memory state: rate limits, Google cooldown and recent command results.
// On serverless hosts each instance has its own copy; Google still enforces its own limits.

export class RateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(seconds: number) {
    super('Too many requests. Please wait before trying again.');
    this.retryAfterSeconds = Math.max(1, Math.ceil(seconds));
  }
}

export class Store {
  values = new Map<string, string>();
  events = new Map<string, number[]>();
  requests = new Map<string, { keyId: string; result: string; at: number }>();

  get(name: string): string | undefined {
    return this.values.get(name);
  }
  set(name: string, value: string) {
    this.values.set(name, value);
  }
  /** Seconds until another event fits within every limit, or 0. */
  wait(bucket: string, limits: { max: number; windowMs: number }[], now = Date.now()) {
    const longest = Math.max(...limits.map((limit) => limit.windowMs));
    const times = (this.events.get(bucket) || []).filter((at) => at > now - longest);
    this.events.set(bucket, times);
    let wait = 0;
    for (const limit of limits) {
      const recent = times.filter((at) => at > now - limit.windowMs);
      if (recent.length >= limit.max)
        wait = Math.max(wait, (recent[recent.length - limit.max] + limit.windowMs - now) / 1000);
    }
    return wait;
  }
  record(bucket: string, now = Date.now()) {
    this.events.set(bucket, [...(this.events.get(bucket) || []), now]);
  }
  reserve(bucket: string, limits: { max: number; windowMs: number }[], now = Date.now()) {
    const wait = this.wait(bucket, limits, now);
    if (wait > 0) throw new RateLimitError(wait);
    this.record(bucket, now);
  }
  getRequest(id: string): { keyId: string; result: string } | undefined {
    return this.requests.get(id);
  }
  saveRequest(id: string, keyId: string, result: unknown, now = Date.now()) {
    for (const [key, entry] of this.requests)
      if (entry.at <= now - 86_400_000) this.requests.delete(key);
    this.requests.set(id, { keyId, result: JSON.stringify(result), at: now });
  }
  audit(keyId: string, action: string, result: string) {
    console.log(`[${new Date().toISOString()}] ${keyId} ${action} ${result}`);
  }
}
