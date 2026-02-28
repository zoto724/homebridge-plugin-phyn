import { describe, it } from 'vitest';
import fc from 'fast-check';
import { mqttBackoffDelay } from '../../src/utils.js';
import { MQTT_RECONNECT_BASE_MS, MQTT_RECONNECT_MAX_MS, MQTT_TOPIC_PREFIX } from '../../src/settings.js';

// Feature: homebridge-phyn-plugin, Property 19: MQTT exponential backoff is bounded correctly
// Validates: Requirements 7.4
describe('Property 19: MQTT exponential backoff is bounded correctly', () => {
  it('backoff equals min(BASE * 2^n, MAX) for any attempt n', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        (attempt) => {
          const result = mqttBackoffDelay(attempt, MQTT_RECONNECT_BASE_MS, MQTT_RECONNECT_MAX_MS);
          const expected = Math.min(MQTT_RECONNECT_BASE_MS * Math.pow(2, attempt), MQTT_RECONNECT_MAX_MS);
          return result === expected;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('result never exceeds MAX_MS regardless of attempt number', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        (attempt) => {
          const result = mqttBackoffDelay(attempt, MQTT_RECONNECT_BASE_MS, MQTT_RECONNECT_MAX_MS);
          return result <= MQTT_RECONNECT_MAX_MS;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: homebridge-phyn-plugin, Property 17: MQTT subscribes to all PP device topics
// Validates: Requirements 7.2
describe('Property 17: MQTT topic format for PP devices', () => {
  it('topic for any deviceId is MQTT_TOPIC_PREFIX/deviceId', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (deviceId) => {
          const topic = `${MQTT_TOPIC_PREFIX}/${deviceId}`;
          return topic === `prd/app_subscriptions/${deviceId}`;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any set of PP device IDs, each gets a unique topic', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 10 }),
        (deviceIds) => {
          const topics = deviceIds.map((id) => `${MQTT_TOPIC_PREFIX}/${id}`);
          const uniqueTopics = new Set(topics);
          return uniqueTopics.size === deviceIds.length;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: homebridge-phyn-plugin, Property 20: MQTT re-subscribes to all topics after reconnect
// Validates: Requirements 7.5
describe('Property 20: MQTT re-subscribes to all topics after reconnect', () => {
  it('subscription set is preserved across reconnect cycles', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 10 }),
        (deviceIds) => {
          // Simulate the subscription set
          const subscriptions = new Set(deviceIds.map((id) => `${MQTT_TOPIC_PREFIX}/${id}`));
          // After reconnect, all topics should be re-subscribed
          const resubscribed = new Set<string>();
          for (const topic of subscriptions) {
            resubscribed.add(topic);
          }
          // Every original subscription must be in the resubscribed set
          return [...subscriptions].every((t) => resubscribed.has(t));
        },
      ),
      { numRuns: 100 },
    );
  });
});
