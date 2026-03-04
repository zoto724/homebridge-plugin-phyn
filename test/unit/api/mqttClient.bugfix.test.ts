/**
 * Bug Condition Exploration Tests — MQTT Reconnect Storm
 *
 * These tests encode the EXPECTED (correct) behavior.
 * They MUST FAIL on unfixed code — failure confirms the bug exists.
 * DO NOT modify mqttClient.ts to make these pass.
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { MqttClient } from '../../../src/api/mqttClient.js';
import { MQTT_RECONNECT_MAX_ATTEMPTS } from '../../../src/settings.js';

// ─── Mock mqtt ────────────────────────────────────────────────────────────────

type EventHandler = (...args: unknown[]) => void;

interface MockMqttInstance {
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  _handlers: Record<string, EventHandler>;
  _emit: (event: string, ...args: unknown[]) => void;
}

function makeMockInstance(): MockMqttInstance {
  const handlers: Record<string, EventHandler> = {};
  const instance: MockMqttInstance = {
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers[event] = handler;
    }),
    subscribe: vi.fn((_topic: string, cb?: (err: null) => void) => { if (cb) cb(null); }),
    end: vi.fn(),
    _handlers: handlers,
    _emit(event: string, ...args: unknown[]) {
      if (handlers[event]) handlers[event](...args);
    },
  };
  return instance;
}

// Track every mqtt.connect() call: which URL was used and return a fresh mock instance
const connectCalls: string[] = [];
let instanceFactory: () => MockMqttInstance = makeMockInstance;

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn((url: string) => {
      connectCalls.push(url);
      return instanceFactory();
    }),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/** Flush all pending timers (including nested ones) up to `depth` levels deep. */
async function flushTimers(depth = 5): Promise<void> {
  for (let i = 0; i < depth; i++) {
    await vi.runAllTimersAsync();
  }
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Bug Condition Exploration — MQTT Reconnect Storm', () => {
  let instances: MockMqttInstance[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    connectCalls.length = 0;
    instances = [];
    instanceFactory = () => {
      const inst = makeMockInstance();
      instances.push(inst);
      return inst;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Test 1: Expired URL Reuse ──────────────────────────────────────────────
  /**
   * Validates: Requirement 1.1
   *
   * EXPECTED behavior: after a `close` event with an expired URL, the next
   * connect() call should use a FRESH URL (not the original cached one).
   *
   * ACTUAL (buggy) behavior: connect() is called with the same expired URL.
   *
   * This test WILL FAIL on unfixed code.
   */
  describe('Test 1 — Expired URL Reuse', () => {
    it('after close event, next connect() uses a fresh URL, not the original expired one', async () => {
      const expiredUrl = 'wss://expired-presigned-url.example.com/mqtt?X-Amz-Expires=300&token=OLD';
      const freshUrl = 'wss://fresh-presigned-url.example.com/mqtt?X-Amz-Expires=300&token=NEW';

      // getFreshUrl simulates getIotPolicy returning a new presigned URL
      const getFreshUrl = vi.fn().mockResolvedValue(freshUrl);

      // Construct with the URL-refresh callback (the fix will accept this)
      const mqttClient = new MqttClient(mockLog as any, getFreshUrl);
      await mqttClient.connect(expiredUrl);

      // Simulate the close event (URL has now expired)
      const firstInstance = instances[0];
      expect(firstInstance).toBeDefined();
      firstInstance._emit('close');

      // Advance timers to trigger the scheduled reconnect
      await flushTimers();

      // EXPECTED: getFreshUrl was called to obtain a fresh URL
      expect(getFreshUrl).toHaveBeenCalled();

      // EXPECTED: the second connect() call used the fresh URL, NOT the expired one
      expect(connectCalls).toHaveLength(2);
      expect(connectCalls[1]).toBe(freshUrl);
      expect(connectCalls[1]).not.toBe(expiredUrl);
    });
  });

  // ── Test 2: Storm Restart — reconnect_failed event ────────────────────────
  /**
   * Validates: Requirement 1.2
   *
   * EXPECTED behavior: after exhausting all MQTT_RECONNECT_MAX_ATTEMPTS,
   * the client emits a 'reconnect_failed' event.
   *
   * ACTUAL (buggy) behavior: the function silently returns — no event emitted.
   *
   * This test WILL FAIL on unfixed code.
   */
  describe('Test 2 — Storm Restart: reconnect_failed event on exhaustion', () => {
    it(`emits 'reconnect_failed' after exhausting all ${MQTT_RECONNECT_MAX_ATTEMPTS} attempts`, async () => {
      const expiredUrl = 'wss://expired.example.com/mqtt';
      const freshUrl = 'wss://fresh.example.com/mqtt';
      const getFreshUrl = vi.fn().mockResolvedValue(freshUrl);

      const mqttClient = new MqttClient(mockLog as any, getFreshUrl);
      const reconnectFailedListener = vi.fn();
      mqttClient.on('reconnect_failed', reconnectFailedListener);

      await mqttClient.connect(expiredUrl);

      // Drive the reconnect loop: each new instance fires 'close' to trigger the next attempt
      // We need to exhaust all MQTT_RECONNECT_MAX_ATTEMPTS
      for (let attempt = 0; attempt < MQTT_RECONNECT_MAX_ATTEMPTS; attempt++) {
        const currentInstance = instances[instances.length - 1];
        currentInstance._emit('close');
        await flushTimers(3);
      }

      // EXPECTED: 'reconnect_failed' was emitted after all attempts were exhausted
      expect(reconnectFailedListener).toHaveBeenCalledTimes(1);
    });
  });

  // ── Test 3: getIotPolicy Call Count ───────────────────────────────────────
  /**
   * Validates: Requirement 1.3
   *
   * EXPECTED behavior: getIotPolicy (via getFreshUrl callback) is called once
   * per reconnect attempt when the URL is expired.
   *
   * ACTUAL (buggy) behavior: getFreshUrl is never called — call count stays 0.
   *
   * This test WILL FAIL on unfixed code.
   */
  describe('Test 3 — getIotPolicy Call Count per Reconnect Attempt', () => {
    it('calls getFreshUrl (getIotPolicy) once per reconnect attempt across 3 close events', async () => {
      const expiredUrl = 'wss://expired.example.com/mqtt';
      let callCount = 0;
      const getFreshUrl = vi.fn().mockImplementation(async () => {
        callCount++;
        return `wss://fresh-${callCount}.example.com/mqtt`;
      });

      const mqttClient = new MqttClient(mockLog as any, getFreshUrl);
      await mqttClient.connect(expiredUrl);

      // Simulate 3 close events (3 reconnect attempts)
      for (let i = 0; i < 3; i++) {
        const currentInstance = instances[instances.length - 1];
        currentInstance._emit('close');
        await flushTimers(3);
      }

      // EXPECTED: getFreshUrl called once per reconnect attempt = 3 times
      expect(getFreshUrl).toHaveBeenCalledTimes(3);
    });
  });

  // ── PBT: Property 1 — Fault Condition ─────────────────────────────────────
  /**
   * Validates: Requirements 1.1, 1.3
   *
   * For any number of close events (1–5) with an expired URL, the fresh URL
   * callback must be called once per attempt and connect() must never reuse
   * the original expired URL after the first connection.
   *
   * This property WILL FAIL on unfixed code.
   */
  describe('PBT — Property 1: Fault Condition — Fresh URL Fetched Before Each Reconnect Attempt', () => {
    it('for any sequence of close events with expired URL, getFreshUrl is called once per attempt and connect() never reuses the expired URL', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (numCloseEvents) => {
            // Reset state for each run
            vi.clearAllMocks();
            connectCalls.length = 0;
            instances.length = 0;

            const expiredUrl = 'wss://expired.example.com/mqtt?token=EXPIRED';
            let freshCallCount = 0;
            const getFreshUrl = vi.fn().mockImplementation(async () => {
              freshCallCount++;
              return `wss://fresh-${freshCallCount}.example.com/mqtt?token=FRESH_${freshCallCount}`;
            });

            const mqttClient = new MqttClient(mockLog as any, getFreshUrl);
            await mqttClient.connect(expiredUrl);

            for (let i = 0; i < numCloseEvents; i++) {
              const currentInstance = instances[instances.length - 1];
              if (!currentInstance) break;
              currentInstance._emit('close');
              await flushTimers(3);
            }

            // Property: getFreshUrl called once per close event
            const expectedCalls = Math.min(numCloseEvents, MQTT_RECONNECT_MAX_ATTEMPTS);
            if (getFreshUrl.mock.calls.length !== expectedCalls) return false;

            // Property: no connect() call after the first uses the expired URL
            const reconnectUrls = connectCalls.slice(1);
            if (reconnectUrls.some((url) => url === expiredUrl)) return false;

            return true;
          },
        ),
        { numRuns: 5 },
      );
    });
  });
});
