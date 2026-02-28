import { PlatformAccessory, CharacteristicValue, HAPStatus } from 'homebridge';
import type { PhynPlatform } from '../platform.js';
import { fahrenheitToCelsius } from '../utils.js';
import { DEFAULT_POLLING_INTERVAL, FIRMWARE_POLL_EVERY_N_CYCLES } from '../settings.js';
import type { PhynDeviceState, PhynMqttPayload } from '../types.js';

export class PPAccessory {
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private pollCycle: number = 0;
  private currentState: PhynDeviceState | null = null;

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

    // Valve service
    const valveService = this.accessory.getService(Service.Valve)
      || this.accessory.addService(Service.Valve);
    valveService.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.WATER_FAUCET);
    valveService.getCharacteristic(Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((value) => this.setActive(value));
    valveService.getCharacteristic(Characteristic.InUse)
      .onGet(() => this.getInUse());

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

    // Switch "Away Mode"
    const awayModeService = this.accessory.getService('Away Mode')
      || this.accessory.addService(Service.Switch, 'Away Mode', 'away-mode');
    awayModeService.getCharacteristic(Characteristic.On)
      .onGet(() => this.getAwayMode())
      .onSet((value) => this.setAwayMode(value));

    // Switch "Auto Shutoff"
    const autoShutoffService = this.accessory.getService('Auto Shutoff')
      || this.accessory.addService(Service.Switch, 'Auto Shutoff', 'auto-shutoff');
    autoShutoffService.getCharacteristic(Characteristic.On)
      .onGet(() => this.getAutoShutoff())
      .onSet((value) => this.setAutoShutoff(value));

    // Register MQTT listener
    this.platform.mqttClient.on('message', (deviceId: string, payload: PhynMqttPayload) => {
      if (deviceId === device.device_id) {
        this.updateFromMqtt(payload);
      }
    });

    // Subscribe to MQTT topic
    this.platform.mqttClient.subscribe(device.device_id);

    // Start polling
    const interval = (this.platform.config['pollingInterval'] as number ?? DEFAULT_POLLING_INTERVAL) * 1000;
    this.pollingTimer = setInterval(() => this.poll(), interval);
    // Initial poll
    this.poll();
  }

  private async getActive(): Promise<CharacteristicValue> {
    const { Characteristic } = this.platform;
    if (!this.currentState) return Characteristic.Active.INACTIVE;
    return this.currentState.sov_status?.v === 'Open'
      ? Characteristic.Active.ACTIVE
      : Characteristic.Active.INACTIVE;
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    const device = this.accessory.context.device;
    try {
      if (value === Characteristic.Active.ACTIVE) {
        await this.platform.phynApi.openValve(device.device_id);
      } else {
        await this.platform.phynApi.closeValve(device.device_id);
      }
    } catch (err) {
      this.platform.log.error(`Failed to set valve: ${(err as Error).message}`);
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async getInUse(): Promise<CharacteristicValue> {
    const { Characteristic } = this.platform;
    if (!this.currentState) return Characteristic.InUse.NOT_IN_USE;
    const flow = this.currentState.flow;
    const flowVal = flow?.v ?? flow?.mean ?? 0;
    return flowVal > 0
      ? Characteristic.InUse.IN_USE
      : Characteristic.InUse.NOT_IN_USE;
  }

  private async getLeakDetected(): Promise<CharacteristicValue> {
    const { Characteristic } = this.platform;
    if (!this.currentState) return Characteristic.LeakDetected.LEAK_NOT_DETECTED;
    return this.currentState.alerts?.is_leak
      ? Characteristic.LeakDetected.LEAK_DETECTED
      : Characteristic.LeakDetected.LEAK_NOT_DETECTED;
  }

  private async getCurrentTemperature(): Promise<CharacteristicValue> {
    if (!this.currentState) return 0;
    const temp = this.currentState.temperature;
    return fahrenheitToCelsius(temp?.v ?? temp?.mean ?? 32);
  }

  private async getAwayMode(): Promise<CharacteristicValue> {
    try {
      const device = this.accessory.context.device;
      const prefs = await this.platform.phynApi.getDevicePreferences(device.device_id);
      const awayPref = prefs.find(p => p.name === 'leak_sensitivity_away_mode');
      return awayPref?.value === 'true';
    } catch (err) {
      this.platform.log.error(`Failed to get away mode: ${(err as Error).message}`);
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async setAwayMode(value: CharacteristicValue): Promise<void> {
    const device = this.accessory.context.device;
    try {
      await this.platform.phynApi.setDevicePreferences(device.device_id, [{
        device_id: device.device_id,
        name: 'leak_sensitivity_away_mode',
        value: value ? 'true' : 'false',
      }]);
    } catch (err) {
      this.platform.log.error(`Failed to set away mode: ${(err as Error).message}`);
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async getAutoShutoff(): Promise<CharacteristicValue> {
    try {
      const device = this.accessory.context.device;
      const result = await this.platform.phynApi.getAutoShutoff(device.device_id);
      return result.auto_shutoff_enable;
    } catch (err) {
      this.platform.log.error(`Failed to get auto shutoff: ${(err as Error).message}`);
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async setAutoShutoff(value: CharacteristicValue): Promise<void> {
    const device = this.accessory.context.device;
    try {
      await this.platform.phynApi.setAutoShutoffEnabled(device.device_id, value as boolean);
    } catch (err) {
      this.platform.log.error(`Failed to set auto shutoff: ${(err as Error).message}`);
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async poll(): Promise<void> {
    const device = this.accessory.context.device;
    try {
      const state = await this.platform.phynApi.getDeviceState(device.device_id);

      // Consumption requires a date duration string
      const today = new Date();
      const duration = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
      await this.platform.phynApi.getConsumptionDetails(device.device_id, duration);

      if (this.pollCycle % FIRMWARE_POLL_EVERY_N_CYCLES === 0) {
        try {
          const firmware = await this.platform.phynApi.getFirmwareInfo(device.device_id);
          this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.FirmwareRevision, String(firmware.fw_version ?? ''));
        } catch (err) {
          this.platform.log.warn(`Failed to get firmware info: ${(err as Error).message}`);
        }
      }

      this.pollCycle++;
      this.updateFromState(state);
    } catch (err) {
      this.platform.log.warn(`Polling failed for ${device.device_id}: ${(err as Error).message}`);
    }
  }

  updateFromState(state: PhynDeviceState): void {
    const { Service, Characteristic } = this.platform;
    this.currentState = state;

    const valveService = this.accessory.getService(Service.Valve);
    if (valveService) {
      const isActive = state.sov_status?.v === 'Open'
        ? Characteristic.Active.ACTIVE
        : Characteristic.Active.INACTIVE;
      valveService.updateCharacteristic(Characteristic.Active, isActive);
      const flow = state.flow;
      const flowVal = flow?.v ?? flow?.mean ?? 0;
      const inUse = flowVal > 0
        ? Characteristic.InUse.IN_USE
        : Characteristic.InUse.NOT_IN_USE;
      valveService.updateCharacteristic(Characteristic.InUse, inUse);
    }

    const leakService = this.accessory.getService(Service.LeakSensor);
    if (leakService) {
      const leakDetected = state.alerts?.is_leak
        ? Characteristic.LeakDetected.LEAK_DETECTED
        : Characteristic.LeakDetected.LEAK_NOT_DETECTED;
      leakService.updateCharacteristic(Characteristic.LeakDetected, leakDetected);
    }

    const tempService = this.accessory.getService(Service.TemperatureSensor);
    if (tempService) {
      const temp = state.temperature;
      tempService.updateCharacteristic(
        Characteristic.CurrentTemperature,
        fahrenheitToCelsius(temp?.v ?? temp?.mean ?? 32),
      );
    }
  }

  updateFromMqtt(payload: PhynMqttPayload): void {
    const { Service, Characteristic } = this.platform;

    // sov_state in MQTT maps to sov_status.v in device state
    if (payload.sov_state !== undefined) {
      const valveService = this.accessory.getService(Service.Valve);
      if (valveService) {
        const isActive = payload.sov_state === 'Open'
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE;
        valveService.updateCharacteristic(Characteristic.Active, isActive);
        if (this.currentState) {
          this.currentState.sov_status = { v: payload.sov_state };
        }
      }
    }

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

    if (payload.flow !== undefined && this.currentState) {
      this.currentState.flow = payload.flow;
      const valveService = this.accessory.getService(Service.Valve);
      if (valveService) {
        const flowVal = payload.flow.v ?? payload.flow.mean ?? 0;
        valveService.updateCharacteristic(
          Characteristic.InUse,
          flowVal > 0 ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE,
        );
      }
    }
  }
}
