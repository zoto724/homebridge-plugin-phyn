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
