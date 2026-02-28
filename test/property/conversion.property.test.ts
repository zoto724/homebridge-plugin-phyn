import { describe, it } from 'vitest';
import fc from 'fast-check';
import { fahrenheitToCelsius, detectDeviceType } from '../../src/utils.js';

describe('Conversion property tests', () => {
  // Property 11: Fahrenheit-to-Celsius conversion correctness
  // Validates: Requirements 4.6, 6.2
  describe('Property 11: fahrenheitToCelsius', () => {
    it('matches the rounded formula and stays within ±0.05 of the exact value', () => {
      fc.assert(
        fc.property(
          fc.float({ min: -100, max: 300, noNaN: true }),
          (f) => {
            const result = fahrenheitToCelsius(f);
            const expected = Math.round(((f - 32) * 5 / 9) * 10) / 10;
            const exact = (f - 32) * 5 / 9;
            return result === expected && Math.abs(result - exact) <= 0.05;
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Property 10: Device type detection from product_code
  // Validates: Requirements 3.6
  describe('Property 10: detectDeviceType', () => {
    it('returns PP for any string starting with PP (case-insensitive)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('PP', 'pp', 'Pp', 'pP'),
          fc.string(),
          (prefix, suffix) => detectDeviceType(prefix + suffix) === 'PP',
        ),
        { numRuns: 100 },
      );
    });

    it('returns PC for any string starting with PC (case-insensitive)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('PC', 'pc', 'Pc', 'pC'),
          fc.string(),
          (prefix, suffix) => detectDeviceType(prefix + suffix) === 'PC',
        ),
        { numRuns: 100 },
      );
    });

    it('returns PW for any string starting with PW (case-insensitive)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('PW', 'pw', 'Pw', 'pW'),
          fc.string(),
          (prefix, suffix) => detectDeviceType(prefix + suffix) === 'PW',
        ),
        { numRuns: 100 },
      );
    });

    it('returns UNKNOWN for strings not starting with PP, PC, or PW', () => {
      const knownPrefixes = new Set(['PP', 'PC', 'PW']);
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }).filter(
            (s) => !knownPrefixes.has(s.slice(0, 2).toUpperCase()),
          ),
          (code) => detectDeviceType(code) === 'UNKNOWN',
        ),
        { numRuns: 100 },
      );
    });
  });
});
