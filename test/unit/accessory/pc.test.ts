import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PCAccessory } from '../../../src/accessory/pc.js';

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as pp.test.ts)
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
      const svc = createMockService(name);
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
    CurrentTemperature: 'CurrentTemperature',
    StatusFault: { GENERAL_FAULT: 1, NO_FAULT: 0 },
  };

  const Service: any = {
    AccessoryInformation: { name: 'AccessoryInformation' },
    TemperatureSensor: { name: 'TemperatureSensor' },
  };

  const phynApi: any = {
    getDeviceState: vi.fn().mockResolvedValue({
      device_id: 'dev-pc-001',
      temperature: { mean: 68 },
      online_status: 'online',
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
  device_id: 'dev-pc-001',
  product_code: 'PC21',
  serial_number: 'SN-PC-001',
  firmware_version: '3.0.0',
  online_status: 'online',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PCAccessory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('TemperatureSensor services', () => {
    it('creates "Hot Water Temperature" TemperatureSensor service with subtype "hot-temp"', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PCAccessory(platform as any, accessory as any);

      const addServiceCalls: any[][] = accessory.addService.mock.calls;
      const hotTempCall = addServiceCalls.find(
        (c) => c[1] === 'Hot Water Temperature' && c[2] === 'hot-temp',
      );
      expect(hotTempCall).toBeDefined();
    });

    it('creates "Cold Water Temperature" TemperatureSensor service with subtype "cold-temp"', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PCAccessory(platform as any, accessory as any);

      const addServiceCalls: any[][] = accessory.addService.mock.calls;
      const coldTempCall = addServiceCalls.find(
        (c) => c[1] === 'Cold Water Temperature' && c[2] === 'cold-temp',
      );
      expect(coldTempCall).toBeDefined();
    });

    it('"Hot Water Temperature" service exists in the services map', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PCAccessory(platform as any, accessory as any);

      const hotSvc = accessory._services.get('Hot Water Temperature');
      expect(hotSvc).toBeDefined();
      expect(hotSvc.subtype).toBe('hot-temp');
    });

    it('"Cold Water Temperature" service exists in the services map', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PCAccessory(platform as any, accessory as any);

      const coldSvc = accessory._services.get('Cold Water Temperature');
      expect(coldSvc).toBeDefined();
      expect(coldSvc.subtype).toBe('cold-temp');
    });

    it('registers onGet handler for Hot Water Temperature CurrentTemperature', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PCAccessory(platform as any, accessory as any);

      const hotSvc = accessory._services.get('Hot Water Temperature');
      const tempChar = hotSvc.getCharacteristic(platform.Characteristic.CurrentTemperature);
      expect(tempChar.onGet).toHaveBeenCalled();
    });

    it('registers onGet handler for Cold Water Temperature CurrentTemperature', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PCAccessory(platform as any, accessory as any);

      const coldSvc = accessory._services.get('Cold Water Temperature');
      const tempChar = coldSvc.getCharacteristic(platform.Characteristic.CurrentTemperature);
      expect(tempChar.onGet).toHaveBeenCalled();
    });
  });

  describe('AccessoryInformation service', () => {
    it('sets Manufacturer to "Phyn"', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PCAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const manufacturerCall = calls.find((c) => c[0] === platform.Characteristic.Manufacturer);
      expect(manufacturerCall?.[1]).toBe('Phyn');
    });

    it('sets Model to device product_code', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PCAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const modelCall = calls.find((c) => c[0] === platform.Characteristic.Model);
      expect(modelCall?.[1]).toBe(defaultDevice.product_code);
    });

    it('sets SerialNumber to device serial_number', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PCAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const serialCall = calls.find((c) => c[0] === platform.Characteristic.SerialNumber);
      expect(serialCall?.[1]).toBe(defaultDevice.serial_number);
    });

    it('sets FirmwareRevision to device firmware_version', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PCAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const firmwareCall = calls.find((c) => c[0] === platform.Characteristic.FirmwareRevision);
      expect(firmwareCall?.[1]).toBe(defaultDevice.firmware_version);
    });
  });

  describe('setFault()', () => {
    it('setFault(true) sets StatusFault to GENERAL_FAULT on both temperature services', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      const pc = new PCAccessory(platform as any, accessory as any);
      pc.setFault(true);

      const hotSvc = accessory._services.get('Hot Water Temperature');
      const coldSvc = accessory._services.get('Cold Water Temperature');

      const hotCalls: any[][] = hotSvc.updateCharacteristic.mock.calls;
      const coldCalls: any[][] = coldSvc.updateCharacteristic.mock.calls;

      const hotFaultCall = hotCalls.find((c) => c[0] === platform.Characteristic.StatusFault);
      const coldFaultCall = coldCalls.find((c) => c[0] === platform.Characteristic.StatusFault);

      expect(hotFaultCall?.[1]).toBe(platform.Characteristic.StatusFault.GENERAL_FAULT);
      expect(coldFaultCall?.[1]).toBe(platform.Characteristic.StatusFault.GENERAL_FAULT);
    });

    it('setFault(false) sets StatusFault to NO_FAULT on both temperature services', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      const pc = new PCAccessory(platform as any, accessory as any);
      pc.setFault(false);

      const hotSvc = accessory._services.get('Hot Water Temperature');
      const coldSvc = accessory._services.get('Cold Water Temperature');

      const hotCalls: any[][] = hotSvc.updateCharacteristic.mock.calls;
      const coldCalls: any[][] = coldSvc.updateCharacteristic.mock.calls;

      const hotFaultCall = hotCalls.find((c) => c[0] === platform.Characteristic.StatusFault);
      const coldFaultCall = coldCalls.find((c) => c[0] === platform.Characteristic.StatusFault);

      expect(hotFaultCall?.[1]).toBe(platform.Characteristic.StatusFault.NO_FAULT);
      expect(coldFaultCall?.[1]).toBe(platform.Characteristic.StatusFault.NO_FAULT);
    });
  });
});
