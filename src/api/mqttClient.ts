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
  private clientGeneration: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting: boolean = false;

  constructor(
    private readonly log: Logging,
    private readonly getFreshUrl?: () => Promise<string>,
  ) {
    super();
  }

  async connect(wsUrl: string): Promise<void> {
    // Cancel any pending reconnect timer — a fresh connect supersedes it
    this.clearReconnectTimer();
    this.reconnecting = false;

    // Close previous client if one exists to avoid memory leaks
    if (this.client) {
      try {
        this.client.end();
      } catch { /* best-effort */ }
    }

    this.wsUrl = wsUrl;
    const generation = ++this.clientGeneration;
    // Disable mqtt.js built-in auto-reconnect to prevent connect storms;
    // we manage reconnection ourselves via scheduleReconnect().
    this.client = mqtt.connect(wsUrl, { protocol: 'wss', reconnectPeriod: 0 });

    this.client.on('message', (topic: string, message: Buffer) => {
      this.onMessage(topic, message);
    });

    this.client.on('error', (err: Error) => {
      this.log.error(`MQTT error: ${err.message}`);
    });

    this.client.on('close', () => {
      // Ignore close events from superseded client instances
      if (generation !== this.clientGeneration) return;
      // Ignore if a reconnect is already scheduled/in-flight
      if (this.reconnecting) return;
      this.log.warn('MQTT connection closed, scheduling reconnect');
      this.scheduleReconnect();
    });

    this.client.on('connect', () => {
      this.log.info('MQTT connected');
      this.reconnectAttempts = 0;
      this.reconnecting = false;
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
    this.clearReconnectTimer();
    this.reconnecting = false;
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  /** Reset attempt counter and try connecting again with a fresh URL. */
  async reconnectFromScratch(): Promise<void> {
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.scheduleReconnect();
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

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    // Prevent overlapping reconnect chains
    this.clearReconnectTimer();
    this.reconnecting = true;

    const delay = mqttBackoffDelay(this.reconnectAttempts, MQTT_RECONNECT_BASE_MS, MQTT_RECONNECT_MAX_MS);
    const attempt = ++this.reconnectAttempts;

    this.log.info(`MQTT reconnecting in ${delay}ms (attempt ${attempt})`);

    if (this.reconnectAttempts >= MQTT_RECONNECT_MAX_ATTEMPTS) {
      this.log.error(`MQTT reconnect failed after ${MQTT_RECONNECT_MAX_ATTEMPTS} attempts`);
      this.reconnecting = false;
      this.emit('reconnect_failed');
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        // Always fetch a fresh presigned URL when possible; fall back to cached URL
        const urlToUse = this.getFreshUrl ? await this.getFreshUrl() : this.wsUrl;
        await this.connect(urlToUse);
        // Re-subscribe to all topics
        for (const topic of this.subscriptions) {
          if (this.client) {
            this.client.subscribe(topic, (err) => {
              if (err) {
                this.log.error(`Failed to re-subscribe to ${topic}: ${err.message}`);
              }
            });
          }
          this.log.info(`Re-subscribed to ${topic}`);
        }
      } catch (err) {
        this.log.error(`MQTT reconnect error: ${(err as Error).message}`);
        this.scheduleReconnect();
      }
    }, delay);
  }
}
