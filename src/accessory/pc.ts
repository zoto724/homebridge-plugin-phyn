import type { PlatformAccessory } from 'homebridge';
import type { PhynPlatform } from '../platform.js';
import { fahrenheitToCelsius } from '../utils.js';
import { DEFAULT_POLLING_INTERVAL } from '../settings.js';
import type { PhynDeviceState } from '../types.js';

export class PCAccessory {
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

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

    // Hot Water Temperature sensor
    const hotTempService = this.accessory.getService('Hot Water Temperature')
      || this.accessory.addService(Service.TemperatureSensor, 'Hot Water Temperature', 'hot-temp');
    hotTempService.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.getHotTemperature());

    // Cold Water Temperature sensor
    const coldTempService = this.accessory.getService('Cold Water Temperature')
      || this.accessory.addService(Service.TemperatureSensor, 'Cold Water Temperature', 'cold-temp');
    coldTempService.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.getColdTemperature());

    // Start polling
    const interval = (this.platform.config['pollingInterval'] as number ?? DEFAULT_POLLING_INTERVAL) * 1000;
    this.pollingTimer = setInterval(() => this.poll(), interval);
    this.poll();
  }

  private async getHotTemperature(): Promise<number> {
    return 0; // Will be updated by polling
  }

  private async getColdTemperature(): Promise<number> {
    return 0; // Will be updated by polling
  }

  private async poll(): Promise<void> {
    const device = this.accessory.context.device;
    try {
      const state = await this.platform.phynApi.getDeviceState(device.device_id);
      this.updateFromState(state);
    } catch (err) {
      this.platform.log.warn(`Polling failed for ${device.device_id}: ${(err as Error).message}`);
    }
  }

  updateFromState(state: PhynDeviceState): void {
    const { Characteristic } = this.platform;

    const tempC = fahrenheitToCelsius(state.temperature?.mean ?? 32);

    const hotTempService = this.accessory.getService('Hot Water Temperature');
    if (hotTempService) {
      hotTempService.updateCharacteristic(Characteristic.CurrentTemperature, tempC);
    }

    const coldTempService = this.accessory.getService('Cold Water Temperature');
    if (coldTempService) {
      coldTempService.updateCharacteristic(Characteristic.CurrentTemperature, tempC);
    }

    // Set fault status based on online_status
    this.setFault(state.online_status !== 'online');
  }

  setFault(fault: boolean): void {
    const { Characteristic } = this.platform;
    const faultValue = fault
      ? Characteristic.StatusFault.GENERAL_FAULT
      : Characteristic.StatusFault.NO_FAULT;

    const hotTempService = this.accessory.getService('Hot Water Temperature');
    if (hotTempService) {
      hotTempService.updateCharacteristic(Characteristic.StatusFault, faultValue);
    }

    const coldTempService = this.accessory.getService('Cold Water Temperature');
    if (coldTempService) {
      coldTempService.updateCharacteristic(Characteristic.StatusFault, faultValue);
    }
  }
}
