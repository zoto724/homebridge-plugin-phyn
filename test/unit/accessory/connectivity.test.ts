/**
 * Connectivity fix tests for accessories
 *
 * Covers:
 *  - #6  Polling concurrency guard (PP, PC, PW)
 *  - #7  Removed wasted consumption API call (PP)
 *  - #9  MQTT integration for PCAccessory
 *  - #10 MQTT integration for PWAccessory
 *  - #11 Cleanup of polling timers and MQTT listeners (PP, PC, PW)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PPAccessory } from '../../../src/accessory/pp.js';
import { PCAccessory } from '../../../src/accessory/pc.js';
import { PWAccessory } from '../../../src/accessory/pw.js';

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

function createMockCharacteristic() {
  const char: any = {
    onGet: vi.fn().mockReturnThis(),
    onSet: vi.fn().mockReturnThis(),
    updateValue: vi.fn().mockReturnThis(),
    setValue: vi.fn().mockReturnThis(),
    getValue: vi.fn().mockReturnThis(),
  };
  return char;
}

function createMockService(name?: string) {
  const characteristics = new Map<any, any>();
  const svc: any = {
    name,
    setCharacteristic: vi.fn().mockReturnThis(),
    getCharacteristic: vi.fn((char: any) => {
      if (!characteristics.has(char)) {
        characteristics.set(char, createMockCharacteristic());
      }
      return characteristics.get(char);
    }),
    updateCharacteristic: vi.fn().mockReturnThis(),
  };
  return svc;
}

function createMockAccessory(device: any) {
  const services = new Map<any, any>();
  const infoSvc = createMockService('AccessoryInformation');
  services.set('AccessoryInformation', infoSvc);

  const acc: any = {
    context: { device },
    displayName: device.device_id,
    UUID: `uuid-${device.device_id}`,
    getService: vi.fn((serviceOrName: any) => {
      const key = typeof serviceOrName === 'string' ? serviceOrName : serviceOrName?.name ?? serviceOrName;
      return services.get(key) ?? null;
    }),
    addService: vi.fn((service: any, name?: string, subtype?: string) => {
      const key = name ?? service?.name ?? service;
      const svc = createMockService(name);
      svc.subtype = subtype;
      services.set(key, svc);
      return svc;
    }),
    _services: services,
  };
  return acc;
}

function createPPMockPlatform(apiOverrides: any = {}) {
  const Characteristic: any = {
    Manufacturer: 'Manufacturer', Model: 'Model', SerialNumber: 'SerialNumber',
    FirmwareRevision: 'FirmwareRevision', Active: { ACTIVE: 1, INACTIVE: 0 },
    InUse: { IN_USE: 1, NOT_IN_USE: 0 },
    LeakDetected: { LEAK_DETECTED: 1, LEAK_NOT_DETECTED: 0 },
    CurrentTemperature: 'CurrentTemperature',
    ValveType: { WATER_FAUCET: 2 }, On: 'On', Name: 'Name',
  };
  const Service: any = {
    AccessoryInformation: { name: 'AccessoryInformation' },
    Valve: { name: 'Valve' }, LeakSensor: { name: 'LeakSensor' },
    TemperatureSensor: { name: 'TemperatureSensor' }, Switch: { name: 'Switch' },
  };
  const phynApi: any = {
    openValve: vi.fn().mockResolvedValue(undefined),
    closeValve: vi.fn().mockResolvedValue(undefined),
    getDeviceState: vi.fn().mockResolvedValue({
      device_id: 'dev-001', sov_status: { v: 'Open' },
      flow: { mean: 0 }, pressure: { mean: 0 }, temperature: { mean: 68 },
      online_status: { v: 'online' },
    }),
    getConsumptionDetails: vi.fn().mockResolvedValue({}),
    getFirmwareInfo: vi.fn().mockResolvedValue({ fw_version: '1.0' }),
    getDevicePreferences: vi.fn().mockResolvedValue([]),
    setDevicePreferences: vi.fn().mockResolvedValue(undefined),
    getAutoShutoff: vi.fn().mockResolvedValue({ auto_shutoff_enable: false }),
    setAutoShutoffEnabled: vi.fn().mockResolvedValue(undefined),
    ...apiOverrides,
  };
  const mqttClient: any = {
    on: vi.fn(),
    subscribe: vi.fn(),
    removeListener: vi.fn(),
  };
  return {
    Service, Characteristic, phynApi, mqttClient,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: { pollingInterval: 60 },
    api: { hap: { HapStatusError: class extends Error { constructor(s: number) { super(`${s}`); } } } },
  };
}

function createPCMockPlatform(apiOverrides: any = {}) {
  const Characteristic: any = {
    Manufacturer: 'Manufacturer', Model: 'Model', SerialNumber: 'SerialNumber',
    FirmwareRevision: 'FirmwareRevision', CurrentTemperature: 'CurrentTemperature',
    StatusFault: { GENERAL_FAULT: 1, NO_FAULT: 0 },
  };
  const Service: any = {
    AccessoryInformation: { name: 'AccessoryInformation' },
    TemperatureSensor: { name: 'TemperatureSensor' },
  };
  const phynApi: any = {
    getDeviceState: vi.fn().mockResolvedValue({
      device_id: 'dev-pc-001', temperature1: { mean: 68 }, temperature2: { mean: 65 },
      online_status: { v: 'online' },
    }),
    ...apiOverrides,
  };
  const mqttClient: any = {
    on: vi.fn(),
    subscribe: vi.fn(),
    removeListener: vi.fn(),
  };
  return {
    Service, Characteristic, phynApi, mqttClient,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: { pollingInterval: 60 },
  };
}

function createPWMockPlatform(apiOverrides: any = {}) {
  const Characteristic: any = {
    Manufacturer: 'Manufacturer', Model: 'Model', SerialNumber: 'SerialNumber',
    FirmwareRevision: 'FirmwareRevision',
    LeakDetected: { LEAK_DETECTED: 1, LEAK_NOT_DETECTED: 0 },
    CurrentTemperature: 'CurrentTemperature',
    CurrentRelativeHumidity: 'CurrentRelativeHumidity',
    BatteryLevel: 'BatteryLevel',
    StatusLowBattery: { BATTERY_LEVEL_LOW: 1, BATTERY_LEVEL_NORMAL: 0 },
    ChargingState: { NOT_CHARGING: 0 },
  };
  const Service: any = {
    AccessoryInformation: { name: 'AccessoryInformation' },
    LeakSensor: { name: 'LeakSensor' }, TemperatureSensor: { name: 'TemperatureSensor' },
    HumiditySensor: { name: 'HumiditySensor' }, Battery: { name: 'Battery' },
  };
  const phynApi: any = {
    getDeviceState: vi.fn().mockResolvedValue({ device_id: 'dev-pw-001', online_status: { v: 'online' } }),
    getWaterStatistics: vi.fn().mockResolvedValue([{
      ts: Date.now(), temperature: [{ value: 68 }], humidity: [{ value: 50 }],
      battery_level: 80, alerts: { water_detected: false },
    }]),
    ...apiOverrides,
  };
  const mqttClient: any = {
    on: vi.fn(),
    subscribe: vi.fn(),
    removeListener: vi.fn(),
  };
  return {
    Service, Characteristic, phynApi, mqttClient,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: { pollingInterval: 60 },
  };
}

const ppDevice = { device_id: 'dev-001', product_code: 'PP21', serial_number: 'SN1', fw_version: '2.0', online_status: { v: 'online' } };
const pcDevice = { device_id: 'dev-pc-001', product_code: 'PC21', serial_number: 'SN-PC', fw_version: '3.0', online_status: { v: 'online' } };
const pwDevice = { device_id: 'dev-pw-001', product_code: 'PW21', serial_number: 'SN-PW', fw_version: '1.5', online_status: { v: 'online' } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Fix #6 — Polling concurrency guard', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('PPAccessory: second poll is skipped while first is in-flight', async () => {
    let resolveFirst: (() => void) | undefined;
    const platform = createPPMockPlatform({
      getDeviceState: vi.fn().mockImplementation(() => new Promise<any>((r) => {
        resolveFirst = () => r({ device_id: 'dev-001', sov_status: { v: 'Open' }, flow: { mean: 0 }, temperature: { mean: 68 } });
      })),
    });
    const accessory = createMockAccessory(ppDevice);
    const pp = new PPAccessory(platform as any, accessory as any);

    // First poll is already running from constructor; start a second
    const secondPoll = (pp as any).poll();

    // getDeviceState should only be called once (the first, still pending)
    expect(platform.phynApi.getDeviceState).toHaveBeenCalledTimes(1);

    // Resolve the first poll
    resolveFirst!();
    await secondPoll;
  });

  it('PCAccessory: second poll is skipped while first is in-flight', async () => {
    let resolveFirst: (() => void) | undefined;
    const platform = createPCMockPlatform({
      getDeviceState: vi.fn().mockImplementation(() => new Promise<any>((r) => {
        resolveFirst = () => r({ device_id: 'dev-pc-001', temperature1: { mean: 68 }, temperature2: { mean: 65 }, online_status: { v: 'online' } });
      })),
    });
    const accessory = createMockAccessory(pcDevice);
    const pc = new PCAccessory(platform as any, accessory as any);

    const secondPoll = (pc as any).poll();
    expect(platform.phynApi.getDeviceState).toHaveBeenCalledTimes(1);
    resolveFirst!();
    await secondPoll;
  });

  it('PWAccessory: second poll is skipped while first is in-flight', async () => {
    let resolveFirst: (() => void) | undefined;
    const platform = createPWMockPlatform({
      getDeviceState: vi.fn().mockImplementation(() => new Promise<any>((r) => {
        resolveFirst = () => r({ device_id: 'dev-pw-001', online_status: { v: 'online' } });
      })),
    });
    const accessory = createMockAccessory(pwDevice);
    const pw = new PWAccessory(platform as any, accessory as any);

    const secondPoll = (pw as any).poll();
    expect(platform.phynApi.getDeviceState).toHaveBeenCalledTimes(1);
    resolveFirst!();
    await secondPoll;
  });
});

describe('Fix #7 — Removed wasted consumption API call (PP)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('PPAccessory poll does NOT call getConsumptionDetails', async () => {
    const platform = createPPMockPlatform();
    const accessory = createMockAccessory(ppDevice);
    new PPAccessory(platform as any, accessory as any);

    // Initial poll runs in constructor, advance to let it complete
    await vi.advanceTimersByTimeAsync(100);

    expect(platform.phynApi.getConsumptionDetails).not.toHaveBeenCalled();
  });
});

describe('Fix #9 — MQTT integration for PCAccessory', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('subscribes to MQTT topic for the device', () => {
    const platform = createPCMockPlatform();
    const accessory = createMockAccessory(pcDevice);
    new PCAccessory(platform as any, accessory as any);

    expect(platform.mqttClient.subscribe).toHaveBeenCalledWith(pcDevice.device_id);
  });

  it('registers a message listener on the MQTT client', () => {
    const platform = createPCMockPlatform();
    const accessory = createMockAccessory(pcDevice);
    new PCAccessory(platform as any, accessory as any);

    expect(platform.mqttClient.on).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('updateFromMqtt updates temperature from MQTT payload', () => {
    const platform = createPCMockPlatform();
    const accessory = createMockAccessory(pcDevice);
    const pc = new PCAccessory(platform as any, accessory as any);

    pc.updateFromMqtt({
      sensor_data: { temperature: { v: 100 } },
    });

    const hotSvc = accessory._services.get('Hot Water Temperature');
    expect(hotSvc.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.CurrentTemperature,
      expect.any(Number),
    );
  });
});

describe('Fix #10 — MQTT integration for PWAccessory', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('subscribes to MQTT topic for the device', () => {
    const platform = createPWMockPlatform();
    const accessory = createMockAccessory(pwDevice);
    new PWAccessory(platform as any, accessory as any);

    expect(platform.mqttClient.subscribe).toHaveBeenCalledWith(pwDevice.device_id);
  });

  it('registers a message listener on the MQTT client', () => {
    const platform = createPWMockPlatform();
    const accessory = createMockAccessory(pwDevice);
    new PWAccessory(platform as any, accessory as any);

    expect(platform.mqttClient.on).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('updateFromMqtt updates temperature from MQTT payload', () => {
    const platform = createPWMockPlatform();
    const accessory = createMockAccessory(pwDevice);
    const pw = new PWAccessory(platform as any, accessory as any);

    pw.updateFromMqtt({
      sensor_data: { temperature: { v: 90 } },
    });

    const tempSvc = accessory._services.get('TemperatureSensor');
    expect(tempSvc.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.CurrentTemperature,
      expect.any(Number),
    );
  });
});

describe('Fix #11 — Cleanup of polling timers and MQTT listeners', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('PPAccessory.destroy() clears polling timer', () => {
    const platform = createPPMockPlatform();
    const accessory = createMockAccessory(ppDevice);
    const pp = new PPAccessory(platform as any, accessory as any);

    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    pp.destroy();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('PPAccessory.destroy() removes MQTT listener', () => {
    const platform = createPPMockPlatform();
    const accessory = createMockAccessory(ppDevice);
    const pp = new PPAccessory(platform as any, accessory as any);

    pp.destroy();
    expect(platform.mqttClient.removeListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('PCAccessory.destroy() clears polling timer', () => {
    const platform = createPCMockPlatform();
    const accessory = createMockAccessory(pcDevice);
    const pc = new PCAccessory(platform as any, accessory as any);

    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    pc.destroy();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('PCAccessory.destroy() removes MQTT listener', () => {
    const platform = createPCMockPlatform();
    const accessory = createMockAccessory(pcDevice);
    const pc = new PCAccessory(platform as any, accessory as any);

    pc.destroy();
    expect(platform.mqttClient.removeListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('PWAccessory.destroy() clears polling timer', () => {
    const platform = createPWMockPlatform();
    const accessory = createMockAccessory(pwDevice);
    const pw = new PWAccessory(platform as any, accessory as any);

    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    pw.destroy();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('PWAccessory.destroy() removes MQTT listener', () => {
    const platform = createPWMockPlatform();
    const accessory = createMockAccessory(pwDevice);
    const pw = new PWAccessory(platform as any, accessory as any);

    pw.destroy();
    expect(platform.mqttClient.removeListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('PPAccessory.destroy() is idempotent (safe to call twice)', () => {
    const platform = createPPMockPlatform();
    const accessory = createMockAccessory(ppDevice);
    const pp = new PPAccessory(platform as any, accessory as any);

    pp.destroy();
    pp.destroy(); // second call should not throw
    expect(platform.mqttClient.removeListener).toHaveBeenCalledTimes(1);
  });
});
