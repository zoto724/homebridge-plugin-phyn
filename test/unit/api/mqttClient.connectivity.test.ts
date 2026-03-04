/**
 * Connectivity fix tests for MqttClient
 *
 * Covers:
 *  - #1  Stale WSS URL: getFreshUrl always used on reconnect, this.wsUrl updated
 *  - #5  Double reconnect_failed: only emitted once regardless of timing
 *  - #12 Old client cleanup: previous MQTT client is closed before reconnect
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MqttClient } from '../../../src/api/mqttClient.js';
import {
  MQTT_RECONNECT_MAX_ATTEMPTS,
  MQTT_RECONNECT_BASE_MS,
  MQTT_RECONNECT_MAX_MS,
} from '../../../src/settings.js';
import { mqttBackoffDelay } from '../../../src/utils.js';

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

const connectCalls: string[] = [];
const connectOptions: Record<string, unknown>[] = [];
let instances: MockMqttInstance[] = [];

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn((url: string, opts?: Record<string, unknown>) => {
      connectCalls.push(url);
      connectOptions.push(opts ?? {});
      const inst = makeMockInstance();
      instances.push(inst);
      return inst;
    }),
  },
}));

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

async function flushTimers(depth = 5): Promise<void> {
  for (let i = 0; i < depth; i++) {
    await vi.runAllTimersAsync();
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Fix #12 — Old MQTT client closed on reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    connectCalls.length = 0;
    connectOptions.length = 0;
    instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the previous client instance before creating a new one on reconnect', async () => {
    const mqttClient = new MqttClient(mockLog as any);
    await mqttClient.connect('wss://test.example.com/mqtt');

    const firstInstance = instances[0];
    expect(firstInstance).toBeDefined();

    // Trigger reconnect via close event
    firstInstance._emit('close');
    await flushTimers(3);

    // The first client's end() should have been called when connect() was called again
    expect(firstInstance.end).toHaveBeenCalledTimes(1);
    // A new instance should have been created
    expect(instances).toHaveLength(2);
  });

  it('calls end() on old client even when getFreshUrl is provided', async () => {
    const getFreshUrl = vi.fn().mockResolvedValue('wss://fresh.example.com/mqtt');
    const mqttClient = new MqttClient(mockLog as any, getFreshUrl);
    await mqttClient.connect('wss://initial.example.com/mqtt');

    const firstInstance = instances[0];
    firstInstance._emit('close');
    await flushTimers(3);

    expect(firstInstance.end).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);
  });

  it('closes each intermediate client during multiple reconnect cycles', async () => {
    const mqttClient = new MqttClient(mockLog as any);
    await mqttClient.connect('wss://test.example.com/mqtt');

    // Drive 3 reconnect cycles
    for (let i = 0; i < 3; i++) {
      const currentInstance = instances[instances.length - 1];
      currentInstance._emit('close');
      await flushTimers(3);
    }

    // Should have 4 instances total (initial + 3 reconnects)
    expect(instances).toHaveLength(4);
    // First 3 instances should have had end() called
    for (let i = 0; i < 3; i++) {
      expect(instances[i].end).toHaveBeenCalled();
    }
  });
});

describe('Fix #5 — reconnect_failed emitted exactly once', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    connectCalls.length = 0;
    connectOptions.length = 0;
    instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits reconnect_failed exactly once after MAX attempts', async () => {
    const getFreshUrl = vi.fn().mockResolvedValue('wss://fresh.example.com/mqtt');
    const mqttClient = new MqttClient(mockLog as any, getFreshUrl);
    const listener = vi.fn();
    mqttClient.on('reconnect_failed', listener);

    await mqttClient.connect('wss://initial.example.com/mqtt');

    // Drive exactly MAX reconnect cycles
    for (let i = 0; i < MQTT_RECONNECT_MAX_ATTEMPTS; i++) {
      const inst = instances[instances.length - 1];
      inst._emit('close');
      await flushTimers(3);
    }

    // Must be called exactly once — no double emission
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not emit reconnect_failed before MAX attempts are exhausted', async () => {
    const mqttClient = new MqttClient(mockLog as any);
    const listener = vi.fn();
    mqttClient.on('reconnect_failed', listener);

    await mqttClient.connect('wss://test.example.com/mqtt');

    // Drive MAX - 1 cycles (not exhausted yet)
    for (let i = 0; i < MQTT_RECONNECT_MAX_ATTEMPTS - 1; i++) {
      const inst = instances[instances.length - 1];
      inst._emit('close');
      await flushTimers(3);
    }

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('Fix #1 — Fresh URL always used on reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    connectCalls.length = 0;
    connectOptions.length = 0;
    instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates internal wsUrl after reconnect with fresh URL', async () => {
    let callCount = 0;
    const getFreshUrl = vi.fn().mockImplementation(async () => {
      callCount++;
      return `wss://fresh-${callCount}.example.com/mqtt`;
    });

    const mqttClient = new MqttClient(mockLog as any, getFreshUrl);
    await mqttClient.connect('wss://initial.example.com/mqtt');

    // First reconnect: should use fresh-1
    instances[0]._emit('close');
    await flushTimers(3);
    expect(connectCalls[1]).toBe('wss://fresh-1.example.com/mqtt');

    // Second reconnect from the new client: should use fresh-2 (not initial or fresh-1)
    instances[1]._emit('connect'); // reset attempt counter
    instances[1]._emit('close');
    await flushTimers(3);
    expect(connectCalls[2]).toBe('wss://fresh-2.example.com/mqtt');
  });

  it('falls back to cached wsUrl when getFreshUrl is not provided', async () => {
    const mqttClient = new MqttClient(mockLog as any);
    await mqttClient.connect('wss://cached.example.com/mqtt');

    instances[0]._emit('close');
    await flushTimers(3);

    expect(connectCalls[1]).toBe('wss://cached.example.com/mqtt');
  });

  it('uses getFreshUrl even when the previous fresh URL was valid', async () => {
    const getFreshUrl = vi.fn().mockResolvedValue('wss://always-fresh.example.com/mqtt');
    const mqttClient = new MqttClient(mockLog as any, getFreshUrl);
    await mqttClient.connect('wss://initial.example.com/mqtt');

    // Reconnect 3 times — getFreshUrl should be called each time
    for (let i = 0; i < 3; i++) {
      const inst = instances[instances.length - 1];
      inst._emit('connect'); // reset counter
      inst._emit('close');
      await flushTimers(3);
    }

    expect(getFreshUrl).toHaveBeenCalledTimes(3);
  });
});

// ─── Connect Storm Prevention ─────────────────────────────────────────────────

describe('Connect storm prevention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    connectCalls.length = 0;
    connectOptions.length = 0;
    instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disables mqtt.js built-in auto-reconnect (reconnectPeriod: 0)', async () => {
    const mqttClient = new MqttClient(mockLog as any);
    await mqttClient.connect('wss://test.example.com/mqtt');

    expect(connectOptions[0]).toMatchObject({ reconnectPeriod: 0 });
  });

  it('does not create multiple reconnect timers from rapid close events', async () => {
    const mqttClient = new MqttClient(mockLog as any);
    await mqttClient.connect('wss://test.example.com/mqtt');

    const inst = instances[0];
    // Fire close 5 times rapidly (simulating what the storm bug would trigger)
    for (let i = 0; i < 5; i++) {
      inst._emit('close');
    }

    // Advance through the reconnect delay
    await flushTimers(3);

    // Only 1 reconnect should have happened (initial connect + 1 reconnect = 2 total)
    expect(instances).toHaveLength(2);
  });

  it('connect() cancels pending reconnect timer', async () => {
    const mqttClient = new MqttClient(mockLog as any);
    await mqttClient.connect('wss://test.example.com/mqtt');

    // Trigger a close → scheduleReconnect starts a timer
    instances[0]._emit('close');

    // Before the timer fires, manually call connect() with a new URL
    await mqttClient.connect('wss://manual-connect.example.com/mqtt');

    // Advance timers — the old scheduled reconnect should NOT fire
    await flushTimers(5);

    // Should have 3 instances: initial, manual connect, no extra from old timer
    // (manual connect creates instance 2; if old timer fired it would create 3)
    expect(instances).toHaveLength(2);
    expect(connectCalls[1]).toBe('wss://manual-connect.example.com/mqtt');
  });

  it('disconnect() cancels pending reconnect timer', async () => {
    const mqttClient = new MqttClient(mockLog as any);
    await mqttClient.connect('wss://test.example.com/mqtt');

    instances[0]._emit('close');

    // Disconnect before timer fires
    mqttClient.disconnect();

    // Advance timers — nothing should happen
    await flushTimers(5);

    // Only the initial instance should exist
    expect(instances).toHaveLength(1);
  });

  it('disconnect() prevents reconnect when old client emits close', async () => {
    const mqttClient = new MqttClient(mockLog as any);
    await mqttClient.connect('wss://test.example.com/mqtt');

    const oldInstance = instances[0];
    mqttClient.disconnect();

    // Some mqtt implementations emit close after end(); this must not trigger reconnect.
    oldInstance._emit('close');
    await flushTimers(5);

    expect(instances).toHaveLength(1);
  });

  it('reconnectFromScratch() cancels any pending reconnect and starts fresh', async () => {
    const callCount = { n: 0 };
    const getFreshUrl = vi.fn().mockImplementation(async () => {
      callCount.n++;
      return `wss://fresh-${callCount.n}.example.com/mqtt`;
    });
    const mqttClient = new MqttClient(mockLog as any, getFreshUrl);
    await mqttClient.connect('wss://initial.example.com/mqtt');

    // Trigger a close → scheduleReconnect starts an attempt-1 timer
    instances[0]._emit('close');

    // Before that timer fires, call reconnectFromScratch
    await mqttClient.reconnectFromScratch();

    // Advance timers — only the reconnectFromScratch path should proceed
    await flushTimers(5);

    // Should have gotten exactly 1 fresh URL call (from the scratch reconnect),
    // not 2 (which would mean both timers fired)
    expect(getFreshUrl).toHaveBeenCalledTimes(1);
  });

  it('close event from a superseded client does not trigger reconnect', async () => {
    const mqttClient = new MqttClient(mockLog as any);
    await mqttClient.connect('wss://test1.example.com/mqtt');
    const oldInstance = instances[0];

    // Create a new connection (supersedes the first)
    await mqttClient.connect('wss://test2.example.com/mqtt');

    // Old client fires close — should be ignored due to generation mismatch
    oldInstance._emit('close');
    await flushTimers(5);

    // No additional reconnect should have happened (2 manual connects only)
    expect(instances).toHaveLength(2);
  });

  it('reconnectPeriod: 0 is used on every reconnect connect call', async () => {
    const mqttClient = new MqttClient(mockLog as any);
    await mqttClient.connect('wss://test.example.com/mqtt');

    // Trigger close → reconnect cycle
    instances[0]._emit('close');
    await flushTimers(3);

    // Second connect call should also have reconnectPeriod: 0
    expect(connectOptions).toHaveLength(2);
    expect(connectOptions[1]).toMatchObject({ reconnectPeriod: 0 });
  });
});
