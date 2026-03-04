import type { PlatformAccessory } from 'homebridge';
import type { PhynPlatform } from '../platform.js';
import { fahrenheitToCelsius } from '../utils.js';
import { DEFAULT_POLLING_INTERVAL, LOW_BATTERY_THRESHOLD } from '../settings.js';
import type { PhynDeviceState, PhynWaterStats, PhynMqttPayload } from '../types.js';

export class PWAccessory {
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private currentState: PhynDeviceState | null = null;
  private currentStats: PhynWaterStats | null = null;
  private polling: boolean = false;
  private mqttHandler: ((deviceId: string, payload: PhynMqttPayload) => void) | null = null;

  constructor(
    private readonly platform: PhynPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = this.platform;
    const device = this.accessory.context.device;

    // AccessoryInformation
    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Phyn')
      .setCharacteristic(Characteristic.Model, device.product_code)
      .setCharacteristic(Characteristic.SerialNumber, device.serial_number)
      .setCharacteristic(Characteristic.FirmwareRevision, String(device.fw_version ?? ''));

    // LeakSensor service
    const leakService = this.accessory.getService(Service.LeakSensor)
      || this.accessory.addService(Service.LeakSensor);
    leakService.getCharacteristic(Characteristic.LeakDetected)
      .onGet(() => this.getLeakDetected());

    // TemperatureSensor service
    const tempService = this.accessory.getService(Service.TemperatureSensor)
      || this.accessory.addService(Service.TemperatureSensor);
    tempService.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.getCurrentTemperature());

    // HumiditySensor service
    const humidityService = this.accessory.getService(Service.HumiditySensor)
      || this.accessory.addService(Service.HumiditySensor);
    humidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.getCurrentHumidity());

    // Battery service
    const batteryService = this.accessory.getService(Service.Battery)
      || this.accessory.addService(Service.Battery);
    batteryService.getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => this.getBatteryLevel());
    batteryService.getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.getStatusLowBattery());
    batteryService.setCharacteristic(
      Characteristic.ChargingState,
      Characteristic.ChargingState.NOT_CHARGING,
    );

    // Register MQTT listener
    this.mqttHandler = (deviceId: string, payload: PhynMqttPayload) => {
      if (deviceId === device.device_id) {
        this.updateFromMqtt(payload);
      }
    };
    this.platform.mqttClient.on('message', this.mqttHandler);

    // Subscribe to MQTT topic
    this.platform.mqttClient.subscribe(device.device_id);

    // Start polling
    const interval = (this.platform.config['pollingInterval'] as number ?? DEFAULT_POLLING_INTERVAL) * 1000;
    this.pollingTimer = setInterval(() => this.poll(), interval);
    this.poll();
  }

  private async getLeakDetected() {
    const { Characteristic } = this.platform;
    if (!this.currentStats) return Characteristic.LeakDetected.LEAK_NOT_DETECTED;
    return this.currentStats.alerts?.water_detected || this.currentStats.alerts?.water
      ? Characteristic.LeakDetected.LEAK_DETECTED
      : Characteristic.LeakDetected.LEAK_NOT_DETECTED;
  }

  private async getCurrentTemperature(): Promise<number> {
    if (!this.currentStats) return 0;
    const tempData = this.currentStats.temperature;
    if (tempData && tempData.length > 0) {
      return fahrenheitToCelsius(tempData[0].value);
    }
    return 0;
  }

  private async getCurrentHumidity(): Promise<number> {
    if (!this.currentStats) return 0;
    const humData = this.currentStats.humidity;
    if (humData && humData.length > 0) {
      return humData[0].value;
    }
    return 0;
  }

  private async getBatteryLevel(): Promise<number> {
    if (!this.currentStats) return 100;
    return this.currentStats.battery_level ?? 100;
  }

  private async getStatusLowBattery() {
    const { Characteristic } = this.platform;
    if (!this.currentStats) return Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    const level = this.currentStats.battery_level ?? 100;
    return level < LOW_BATTERY_THRESHOLD
      ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // guard against overlapping polls
    this.polling = true;
    const device = this.accessory.context.device;
    try {
      const toTs = Date.now();
      const fromTs = toTs - (3600 * 72 * 1000); // 72 hours back
      const [state, statsArray] = await Promise.all([
        this.platform.phynApi.getDeviceState(device.device_id),
        this.platform.phynApi.getWaterStatistics(device.device_id, fromTs, toTs),
      ]);
      // Pick the most recent entry
      const stats = statsArray.reduce((latest, entry) =>
        (entry.ts ?? 0) > (latest.ts ?? 0) ? entry : latest,
        statsArray[0] ?? null,
      );
      if (stats) {
        this.updateFromState(state, stats);
      }
    } catch (err) {
      this.platform.log.warn(`Polling failed for ${device.device_id}: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  /** Clean up timers and MQTT listeners. */
  destroy(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.mqttHandler) {
      this.platform.mqttClient.removeListener('message', this.mqttHandler);
      this.mqttHandler = null;
    }
  }

  updateFromState(state: PhynDeviceState, stats: PhynWaterStats): void {
    const { Service, Characteristic } = this.platform;
    this.currentState = state;
    this.currentStats = stats;

    // LeakSensor — water_detected is in alerts
    const leakService = this.accessory.getService(Service.LeakSensor);
    if (leakService) {
      const leakDetected = stats.alerts?.water_detected || stats.alerts?.water
        ? Characteristic.LeakDetected.LEAK_DETECTED
        : Characteristic.LeakDetected.LEAK_NOT_DETECTED;
      leakService.updateCharacteristic(Characteristic.LeakDetected, leakDetected);
    }

    // TemperatureSensor — temperature is an array of {value}
    const tempService = this.accessory.getService(Service.TemperatureSensor);
    if (tempService) {
      const tempData = stats.temperature;
      const tempF = tempData && tempData.length > 0 ? tempData[0].value : 32;
      tempService.updateCharacteristic(
        Characteristic.CurrentTemperature,
        fahrenheitToCelsius(tempF),
      );
    }

    // HumiditySensor — humidity is an array of {value}
    const humidityService = this.accessory.getService(Service.HumiditySensor);
    if (humidityService) {
      const humData = stats.humidity;
      const humVal = humData && humData.length > 0 ? humData[0].value : 0;
      humidityService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humVal);
    }

    // Battery
    const batteryService = this.accessory.getService(Service.Battery);
    if (batteryService) {
      const level = stats.battery_level ?? 100;
      batteryService.updateCharacteristic(Characteristic.BatteryLevel, level);
      const lowBattery = level < LOW_BATTERY_THRESHOLD
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      batteryService.updateCharacteristic(Characteristic.StatusLowBattery, lowBattery);
    }
  }

  updateFromMqtt(payload: PhynMqttPayload): void {
    const { Service, Characteristic } = this.platform;

    if (payload.sensor_data?.temperature !== undefined) {
      const tempService = this.accessory.getService(Service.TemperatureSensor);
      if (tempService) {
        const temp = payload.sensor_data.temperature;
        tempService.updateCharacteristic(
          Characteristic.CurrentTemperature,
          fahrenheitToCelsius(temp.v ?? temp.mean ?? 32),
        );
      }
    }
  }
}
