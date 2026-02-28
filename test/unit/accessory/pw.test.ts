import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PWAccessory } from '../../../src/accessory/pw.js';

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as pc.test.ts / pp.test.ts)
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

  // Pre-populate AccessoryInformation
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
      const svc = createMockService(name ?? key);
      svc.subtype = subtype;
      services.set(key, svc);
      return svc;
    }),
    _services: services,
  };
  return acc;
}

function createMockPlatform(apiOverrides: any = {}) {
  const Characteristic: any = {
    Manufacturer: 'Manufacturer',
    Model: 'Model',
    SerialNumber: 'SerialNumber',
    FirmwareRevision: 'FirmwareRevision',
    LeakDetected: { LEAK_DETECTED: 1, LEAK_NOT_DETECTED: 0 },
    CurrentTemperature: 'CurrentTemperature',
    CurrentRelativeHumidity: 'CurrentRelativeHumidity',
    BatteryLevel: 'BatteryLevel',
    StatusLowBattery: { BATTERY_LEVEL_LOW: 1, BATTERY_LEVEL_NORMAL: 0 },
    ChargingState: { NOT_CHARGING: 0, CHARGING: 1, NOT_CHARGEABLE: 2 },
  };

  const Service: any = {
    AccessoryInformation: { name: 'AccessoryInformation' },
    LeakSensor: { name: 'LeakSensor' },
    TemperatureSensor: { name: 'TemperatureSensor' },
    HumiditySensor: { name: 'HumiditySensor' },
    Battery: { name: 'Battery' },
  };

  const phynApi: any = {
    getDeviceState: vi.fn().mockResolvedValue({
      device_id: 'dev-pw-001',
      online_status: 'online',
      alerts: { water_detected: false },
    }),
    getWaterStatistics: vi.fn().mockResolvedValue({
      temperature: 68,
      humidity: 50,
      battery_level: 80,
    }),
    ...apiOverrides,
  };

  return {
    Service,
    Characteristic,
    phynApi,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: { pollingInterval: 60 },
  };
}

const defaultDevice = {
  device_id: 'dev-pw-001',
  product_code: 'PW21',
  serial_number: 'SN-PW-001',
  firmware_version: '1.5.0',
  online_status: 'online',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PWAccessory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Services present', () => {
    it('creates LeakSensor service', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const leakSvc = accessory._services.get('LeakSensor');
      expect(leakSvc).toBeDefined();
    });

    it('creates TemperatureSensor service', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const tempSvc = accessory._services.get('TemperatureSensor');
      expect(tempSvc).toBeDefined();
    });

    it('creates HumiditySensor service', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const humiditySvc = accessory._services.get('HumiditySensor');
      expect(humiditySvc).toBeDefined();
    });

    it('creates Battery service', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const batterySvc = accessory._services.get('Battery');
      expect(batterySvc).toBeDefined();
    });

    it('registers onGet handler for LeakDetected characteristic', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const leakSvc = accessory._services.get('LeakSensor');
      const leakChar = leakSvc.getCharacteristic(platform.Characteristic.LeakDetected);
      expect(leakChar.onGet).toHaveBeenCalled();
    });

    it('registers onGet handler for CurrentTemperature characteristic', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const tempSvc = accessory._services.get('TemperatureSensor');
      const tempChar = tempSvc.getCharacteristic(platform.Characteristic.CurrentTemperature);
      expect(tempChar.onGet).toHaveBeenCalled();
    });

    it('registers onGet handler for CurrentRelativeHumidity characteristic', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const humiditySvc = accessory._services.get('HumiditySensor');
      const humidityChar = humiditySvc.getCharacteristic(platform.Characteristic.CurrentRelativeHumidity);
      expect(humidityChar.onGet).toHaveBeenCalled();
    });

    it('registers onGet handler for BatteryLevel characteristic', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const batterySvc = accessory._services.get('Battery');
      const batteryChar = batterySvc.getCharacteristic(platform.Characteristic.BatteryLevel);
      expect(batteryChar.onGet).toHaveBeenCalled();
    });

    it('registers onGet handler for StatusLowBattery characteristic', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const batterySvc = accessory._services.get('Battery');
      const lowBatteryChar = batterySvc.getCharacteristic(platform.Characteristic.StatusLowBattery);
      expect(lowBatteryChar.onGet).toHaveBeenCalled();
    });
  });

  describe('Battery ChargingState', () => {
    it('sets ChargingState to NOT_CHARGING on the Battery service', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const batterySvc = accessory._services.get('Battery');
      expect(batterySvc).toBeDefined();

      const calls: any[][] = batterySvc.setCharacteristic.mock.calls;
      const chargingStateCall = calls.find((c) => c[0] === platform.Characteristic.ChargingState);
      expect(chargingStateCall).toBeDefined();
      expect(chargingStateCall![1]).toBe(platform.Characteristic.ChargingState.NOT_CHARGING); // 0
    });
  });

  describe('AccessoryInformation service', () => {
    it('sets Manufacturer to "Phyn"', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const manufacturerCall = calls.find((c) => c[0] === platform.Characteristic.Manufacturer);
      expect(manufacturerCall?.[1]).toBe('Phyn');
    });

    it('sets Model to device product_code', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const modelCall = calls.find((c) => c[0] === platform.Characteristic.Model);
      expect(modelCall?.[1]).toBe(defaultDevice.product_code);
    });

    it('sets SerialNumber to device serial_number', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const serialCall = calls.find((c) => c[0] === platform.Characteristic.SerialNumber);
      expect(serialCall?.[1]).toBe(defaultDevice.serial_number);
    });

    it('sets FirmwareRevision to device firmware_version', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PWAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const firmwareCall = calls.find((c) => c[0] === platform.Characteristic.FirmwareRevision);
      expect(firmwareCall?.[1]).toBe(defaultDevice.firmware_version);
    });
  });
});
