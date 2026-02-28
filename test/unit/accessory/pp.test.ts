import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PPAccessory } from '../../../src/accessory/pp.js';

// ---------------------------------------------------------------------------
// Mock helpers
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
    Active: { ACTIVE: 1, INACTIVE: 0 },
    InUse: { IN_USE: 1, NOT_IN_USE: 0 },
    LeakDetected: { LEAK_DETECTED: 1, LEAK_NOT_DETECTED: 0 },
    CurrentTemperature: 'CurrentTemperature',
    ValveType: { WATER: 2, WATER_FAUCET: 2 },
    On: 'On',
  };

  const Service: any = {
    AccessoryInformation: { name: 'AccessoryInformation' },
    Valve: { name: 'Valve' },
    LeakSensor: { name: 'LeakSensor' },
    TemperatureSensor: { name: 'TemperatureSensor' },
    Switch: { name: 'Switch' },
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
    getDevicePreferences: vi.fn().mockResolvedValue([
      { device_id: 'dev-001', name: 'leak_sensitivity_away_mode', value: 'false' },
    ]),
    setDevicePreferences: vi.fn().mockResolvedValue(undefined),
    getAutoShutoff: vi.fn().mockResolvedValue({ auto_shutoff_enable: false }),
    setAutoShutoffEnabled: vi.fn().mockResolvedValue(undefined),
    ...apiOverrides,
  };

  const mqttClient: any = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };

  return {
    Service,
    Characteristic,
    phynApi,
    mqttClient,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: { pollingInterval: 60 },
    api: {
      hap: {
        HapStatusError: class HapStatusError extends Error {
          constructor(public status: number) { super(`HapStatusError: ${status}`); }
        },
      },
    },
  };
}

const defaultDevice = {
  device_id: 'dev-001',
  product_code: 'PP21',
  serial_number: 'SN-001',
  fw_version: '2.0.0',
  online_status: { v: 'online' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PPAccessory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Valve service', () => {
    it('sets ValveType to WATER_FAUCET on the Valve service', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const valveSvc = accessory._services.get('Valve');
      expect(valveSvc).toBeDefined();

      const calls: any[][] = valveSvc.setCharacteristic.mock.calls;
      const valveTypeCall = calls.find((c) => c[0] === platform.Characteristic.ValveType);
      expect(valveTypeCall).toBeDefined();
      expect(valveTypeCall![1]).toBe(platform.Characteristic.ValveType.WATER_FAUCET); // 2
    });

    it('registers onGet and onSet handlers for Active characteristic', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const valveSvc = accessory._services.get('Valve');
      expect(valveSvc).toBeDefined();

      const activeChar = valveSvc.getCharacteristic(platform.Characteristic.Active);
      expect(activeChar.onGet).toHaveBeenCalled();
      expect(activeChar.onSet).toHaveBeenCalled();
    });

    it('registers onGet handler for InUse characteristic', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const valveSvc = accessory._services.get('Valve');
      const inUseChar = valveSvc.getCharacteristic(platform.Characteristic.InUse);
      expect(inUseChar.onGet).toHaveBeenCalled();
    });
  });

  describe('Away Mode Switch service', () => {
    it('creates Away Mode Switch service with subtype "away-mode"', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      // addService should have been called with Switch, 'Away Mode', 'away-mode'
      const addServiceCalls: any[][] = accessory.addService.mock.calls;
      const awayModeCall = addServiceCalls.find(
        (c) => c[1] === 'Away Mode' && c[2] === 'away-mode',
      );
      expect(awayModeCall).toBeDefined();
    });

    it('Away Mode service exists in the services map', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const awayModeSvc = accessory._services.get('Away Mode');
      expect(awayModeSvc).toBeDefined();
      expect(awayModeSvc.subtype).toBe('away-mode');
    });

    it('registers onGet and onSet handlers for Away Mode On characteristic', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const awayModeSvc = accessory._services.get('Away Mode');
      const onChar = awayModeSvc.getCharacteristic(platform.Characteristic.On);
      expect(onChar.onGet).toHaveBeenCalled();
      expect(onChar.onSet).toHaveBeenCalled();
    });
  });

  describe('Auto Shutoff Switch service', () => {
    it('creates Auto Shutoff Switch service with subtype "auto-shutoff"', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const addServiceCalls: any[][] = accessory.addService.mock.calls;
      const autoShutoffCall = addServiceCalls.find(
        (c) => c[1] === 'Auto Shutoff' && c[2] === 'auto-shutoff',
      );
      expect(autoShutoffCall).toBeDefined();
    });

    it('Auto Shutoff service exists in the services map', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const autoShutoffSvc = accessory._services.get('Auto Shutoff');
      expect(autoShutoffSvc).toBeDefined();
      expect(autoShutoffSvc.subtype).toBe('auto-shutoff');
    });

    it('registers onGet and onSet handlers for Auto Shutoff On characteristic', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const autoShutoffSvc = accessory._services.get('Auto Shutoff');
      const onChar = autoShutoffSvc.getCharacteristic(platform.Characteristic.On);
      expect(onChar.onGet).toHaveBeenCalled();
      expect(onChar.onSet).toHaveBeenCalled();
    });
  });

  describe('AccessoryInformation service', () => {
    it('sets Manufacturer to "Phyn"', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const manufacturerCall = calls.find((c) => c[0] === platform.Characteristic.Manufacturer);
      expect(manufacturerCall?.[1]).toBe('Phyn');
    });

    it('sets Model to device product_code', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const modelCall = calls.find((c) => c[0] === platform.Characteristic.Model);
      expect(modelCall?.[1]).toBe(defaultDevice.product_code);
    });

    it('sets SerialNumber to device serial_number', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const serialCall = calls.find((c) => c[0] === platform.Characteristic.SerialNumber);
      expect(serialCall?.[1]).toBe(defaultDevice.serial_number);
    });

    it('sets FirmwareRevision to device fw_version', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const firmwareCall = calls.find((c) => c[0] === platform.Characteristic.FirmwareRevision);
      expect(firmwareCall?.[1]).toBe(defaultDevice.fw_version);
    });

    it('coerces numeric fw_version to string for FirmwareRevision', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory({ ...defaultDevice, fw_version: 20250101 as any });

      new PPAccessory(platform as any, accessory as any);

      const infoSvc = accessory._services.get('AccessoryInformation');
      const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
      const firmwareCall = calls.find((c) => c[0] === platform.Characteristic.FirmwareRevision);
      expect(typeof firmwareCall?.[1]).toBe('string');
      expect(firmwareCall?.[1]).toBe('20250101');
    });
  });

  describe('MQTT subscription', () => {
    it('subscribes to MQTT topic for the device', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      expect(platform.mqttClient.subscribe).toHaveBeenCalledWith(defaultDevice.device_id);
    });

    it('registers a message listener on the MQTT client', () => {
      const platform = createMockPlatform();
      const accessory = createMockAccessory(defaultDevice);

      new PPAccessory(platform as any, accessory as any);

      expect(platform.mqttClient.on).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });
});
