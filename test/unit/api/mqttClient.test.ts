import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MqttClient } from '../../../src/api/mqttClient.js';

// Mock mqtt
const mockSubscribe = vi.fn((topic, cb) => { if (cb) cb(null); });
const mockEnd = vi.fn();
const mockOn = vi.fn();

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn(() => ({
      on: mockOn,
      subscribe: mockSubscribe,
      end: mockEnd,
    })),
  },
}));

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('MqttClient', () => {
  let client: MqttClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MqttClient(mockLog as any);
  });

  describe('connect()', () => {
    it('calls mqtt.connect with the provided wsUrl and wss protocol', async () => {
      const mqtt = (await import('mqtt')).default;
      await client.connect('wss://example.com/mqtt');
      expect(mqtt.connect).toHaveBeenCalledWith('wss://example.com/mqtt', { protocol: 'wss' });
    });

    it('wires message, error, close, and connect event handlers', async () => {
      await client.connect('wss://example.com/mqtt');
      expect(mockOn).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('connect', expect.any(Function));
    });
  });

  describe('subscribe()', () => {
    it('subscribes to prd/app_subscriptions/{deviceId}', async () => {
      await client.connect('wss://example.com/mqtt');
      client.subscribe('device-123');
      expect(mockSubscribe).toHaveBeenCalledWith(
        'prd/app_subscriptions/device-123',
        expect.any(Function),
      );
    });

    it('adds topic to internal subscriptions set', async () => {
      await client.connect('wss://example.com/mqtt');
      client.subscribe('device-abc');
      client.subscribe('device-xyz');
      // Verify by checking that subscribe was called twice
      expect(mockSubscribe).toHaveBeenCalledTimes(2);
    });
  });

  describe('message dispatch', () => {
    it('emits message event with deviceId and parsed payload', async () => {
      await client.connect('wss://example.com/mqtt');

      // Get the message handler that was registered
      const messageHandler = mockOn.mock.calls.find(([event]) => event === 'message')?.[1];
      expect(messageHandler).toBeDefined();

      const messageListener = vi.fn();
      client.on('message', messageListener);

      const payload = { sov_status: 'Open', temperature: { mean: 72 } };
      messageHandler('prd/app_subscriptions/device-123', Buffer.from(JSON.stringify(payload)));

      expect(messageListener).toHaveBeenCalledWith('device-123', payload);
    });

    it('logs warning and does not emit on invalid JSON', async () => {
      await client.connect('wss://example.com/mqtt');

      const messageHandler = mockOn.mock.calls.find(([event]) => event === 'message')?.[1];
      const messageListener = vi.fn();
      client.on('message', messageListener);

      messageHandler('prd/app_subscriptions/device-123', Buffer.from('not-json'));

      expect(messageListener).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalled();
    });
  });

  describe('disconnect()', () => {
    it('calls client.end()', async () => {
      await client.connect('wss://example.com/mqtt');
      client.disconnect();
      expect(mockEnd).toHaveBeenCalled();
    });
  });
});
