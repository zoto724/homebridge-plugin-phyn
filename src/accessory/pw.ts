import type { PlatformAccessory } from 'homebridge';
import type { PhynPlatform } from '../platform.js';
import { fahrenheitToCelsius } from '../utils.js';
import { DEFAULT_POLLING_INTERVAL, LOW_BATTERY_THRESHOLD } from '../settings.js';
import type { PhynDeviceState, PhynWaterStats } from '../types.js';

export class PWAccessory {
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private currentState: PhynDeviceState | null = null;
  private currentStats: PhynWaterStats | null = null;

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
      .setCharacteristic(Characteristic.FirmwareRevision, device.firmware_version);

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

    // Start polling
    const interval = (this.platform.config['pollingInterval'] as number ?? DEFAULT_POLLING_INTERVAL) * 1000;
    this.pollingTimer = setInterval(() => this.poll(), interval);
    this.poll();
  }

  private async getLeakDetected() {
    const { Characteristic } = this.platform;
    if (!this.currentState) return Characteristic.LeakDetected.LEAK_NOT_DETECTED;
    return this.currentState.alerts?.water_detected
      ? Characteristic.LeakDetected.LEAK_DETECTED
      : Characteristic.LeakDetected.LEAK_NOT_DETECTED;
  }

  private async getCurrentTemperature(): Promise<number> {
    if (!this.currentStats) return 0;
    return fahrenheitToCelsius(this.currentStats.temperature);
  }

  private async getCurrentHumidity(): Promise<number> {
    if (!this.currentStats) return 0;
    return this.currentStats.humidity;
  }

  private async getBatteryLevel(): Promise<number> {
    if (!this.currentStats) return 100;
    return this.currentStats.battery_level;
  }

  private async getStatusLowBattery() {
    const { Characteristic } = this.platform;
    if (!this.currentStats) return Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    return this.currentStats.battery_level < LOW_BATTERY_THRESHOLD
      ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private async poll(): Promise<void> {
    const device = this.accessory.context.device;
    try {
      const [state, stats] = await Promise.all([
        this.platform.phynApi.getDeviceState(device.device_id),
        this.platform.phynApi.getWaterStatistics(device.device_id),
      ]);
      this.updateFromState(state, stats);
    } catch (err) {
      this.platform.log.warn(`Polling failed for ${device.device_id}: ${(err as Error).message}`);
    }
  }

  updateFromState(state: PhynDeviceState, stats: PhynWaterStats): void {
    const { Service, Characteristic } = this.platform;
    this.currentState = state;
    this.currentStats = stats;

    // LeakSensor
    const leakService = this.accessory.getService(Service.LeakSensor);
    if (leakService) {
      const leakDetected = state.alerts?.water_detected
        ? Characteristic.LeakDetected.LEAK_DETECTED
        : Characteristic.LeakDetected.LEAK_NOT_DETECTED;
      leakService.updateCharacteristic(Characteristic.LeakDetected, leakDetected);
    }

    // TemperatureSensor
    const tempService = this.accessory.getService(Service.TemperatureSensor);
    if (tempService) {
      tempService.updateCharacteristic(
        Characteristic.CurrentTemperature,
        fahrenheitToCelsius(stats.temperature),
      );
    }

    // HumiditySensor
    const humidityService = this.accessory.getService(Service.HumiditySensor);
    if (humidityService) {
      humidityService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, stats.humidity);
    }

    // Battery
    const batteryService = this.accessory.getService(Service.Battery);
    if (batteryService) {
      batteryService.updateCharacteristic(Characteristic.BatteryLevel, stats.battery_level);
      const lowBattery = stats.battery_level < LOW_BATTERY_THRESHOLD
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      batteryService.updateCharacteristic(Characteristic.StatusLowBattery, lowBattery);
    }
  }
}
