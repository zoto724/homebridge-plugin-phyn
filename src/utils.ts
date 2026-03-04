export type DeviceType = 'PP' | 'PC' | 'PW' | 'UNKNOWN';

// (F - 32) × 5/9, rounded to 1 decimal place
export function fahrenheitToCelsius(f: number): number {
  return Math.round(((f - 32) * 5) / 9 * 10) / 10;
}

export function detectDeviceType(productCode: string): DeviceType {
  const code = productCode.toUpperCase();
  if (code.startsWith('PP')) return 'PP';
  if (code.startsWith('PC')) return 'PC';
  if (code.startsWith('PW')) return 'PW';
  return 'UNKNOWN';
}

// delay = min(BASE_MS * 2^attempt, MAX_MS)
export function mqttBackoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * Math.pow(2, attempt), maxMs);
}

// Exponential backoff with jitter for auth retries
// delay = baseMs * 2^attempt + random(0, baseMs)
export function authRetryDelay(attempt: number, baseMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * baseMs);
  return exponential + jitter;
}
