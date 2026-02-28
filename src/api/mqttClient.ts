import { EventEmitter } from 'node:events';
import mqtt, { MqttClient as MqttClientInstance } from 'mqtt';
import type { Logging } from 'homebridge';
import {
  MQTT_TOPIC_PREFIX,
  MQTT_RECONNECT_BASE_MS,
  MQTT_RECONNECT_MAX_MS,
  MQTT_RECONNECT_MAX_ATTEMPTS,
} from '../settings.js';
import { mqttBackoffDelay } from '../utils.js';
import type { PhynMqttPayload } from '../types.js';

export class MqttClient extends EventEmitter {
  private client: MqttClientInstance | null = null;
  private subscriptions: Set<string> = new Set();
  private reconnectAttempts: number = 0;
  private wsUrl: string = '';

  constructor(private readonly log: Logging) {
    super();
  }

  async connect(wsUrl: string): Promise<void> {
    this.wsUrl = wsUrl;
    this.client = mqtt.connect(wsUrl, { protocol: 'wss' });

    this.client.on('message', (topic: string, message: Buffer) => {
      this.onMessage(topic, message);
    });

    this.client.on('error', (err: Error) => {
      this.log.error(`MQTT error: ${err.message}`);
    });

    this.client.on('close', () => {
      this.log.warn('MQTT connection closed, scheduling reconnect');
      this.scheduleReconnect(this.wsUrl);
    });

    this.client.on('connect', () => {
      this.log.info('MQTT connected');
      this.reconnectAttempts = 0;
    });
  }

  subscribe(deviceId: string): void {
    const topic = `${MQTT_TOPIC_PREFIX}/${deviceId}`;
    this.subscriptions.add(topic);
    if (this.client) {
      this.client.subscribe(topic, (err) => {
        if (err) {
          this.log.error(`Failed to subscribe to ${topic}: ${err.message}`);
        }
      });
    }
  }

  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  private onMessage(topic: string, message: Buffer): void {
    // Extract deviceId from topic: prd/app_subscriptions/{deviceId}
    const parts = topic.split('/');
    const deviceId = parts[parts.length - 1];

    try {
      const payload = JSON.parse(message.toString()) as PhynMqttPayload;
      this.emit('message', deviceId, payload);
    } catch (err) {
      this.log.warn(`Failed to parse MQTT message on topic ${topic}: ${(err as Error).message}`);
    }
  }

  private scheduleReconnect(wsUrl: string): void {
    if (this.reconnectAttempts >= MQTT_RECONNECT_MAX_ATTEMPTS) {
      this.log.error(`MQTT reconnect failed after ${MQTT_RECONNECT_MAX_ATTEMPTS} attempts`);
      return;
    }

    const delay = mqttBackoffDelay(this.reconnectAttempts, MQTT_RECONNECT_BASE_MS, MQTT_RECONNECT_MAX_MS);
    this.reconnectAttempts++;

    this.log.info(`MQTT reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this.connect(wsUrl);
        // Re-subscribe to all topics
        for (const topic of this.subscriptions) {
          const deviceId = topic.split('/').pop()!;
          if (this.client) {
            this.client.subscribe(topic, (err) => {
              if (err) {
                this.log.error(`Failed to re-subscribe to ${topic}: ${err.message}`);
              }
            });
          }
          this.log.info(`Re-subscribed to ${topic}`);
        }
        this.reconnectAttempts = 0;
      } catch (err) {
        this.log.error(`MQTT reconnect error: ${(err as Error).message}`);
        this.scheduleReconnect(wsUrl);
      }
    }, delay);
  }
}
