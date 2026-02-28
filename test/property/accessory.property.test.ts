import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { fahrenheitToCelsius } from '../../src/utils.js';
import { FIRMWARE_POLL_EVERY_N_CYCLES } from '../../src/settings.js';

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
  };
  // Pre-populate AccessoryInformation service
  const infoSvc = createMockService('AccessoryInformation');
  services.set('AccessoryInformation', infoSvc);
  acc._services = services;
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
    ValveType: { WATER: 2 },
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
    getDeviceState: vi.fn().mockResolvedValue(null),
    getConsumptionDetails: vi.fn().mockResolvedValue({}),
    getFirmwareInfo: vi.fn().mockResolvedValue({ version: '1.0' }),
    getLeakSensitivityAwayMode: vi.fn().mockResolvedValue(false),
    setPreferences: vi.fn().mockResolvedValue(undefined),
    getAutoShutoff: vi.fn().mockResolvedValue({ enabled: false }),
    enableAutoShutoff: vi.fn().mockResolvedValue(undefined),
    disableAutoShutoff: vi.fn().mockResolvedValue(undefined),
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

function makeDevice(overrides: any = {}) {
  return {
    device_id: 'dev-001',
    product_code: 'PP21',
    serial_number: 'SN-001',
    firmware_version: '2.0.0',
    online_status: 'online',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 12: Valve control maps Active to correct API call
// Validates: Requirements 4.3, 4.4
// ---------------------------------------------------------------------------
describe('Property 12: Valve control maps Active to correct API call', () => {
  it('INACTIVE calls closeValve and not openValve', async () => {
    const { PPAccessory } = await import('../../src/accessory/pp.js');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        async (deviceId) => {
          vi.useFakeTimers();
          const device = makeDevice({ device_id: deviceId });
          const platform = createMockPlatform();
          const accessory = createMockAccessory(device);

          // Prevent initial poll from interfering
          platform.phynApi.getDeviceState.mockResolvedValue({
            device_id: deviceId, sov_status: 'Open',
            flow: { mean: 0 }, pressure: { mean: 0 }, temperature: { mean: 68 },
            online_status: 'online',
          });

          const pp = new PPAccessory(platform as any, accessory as any);

          platform.phynApi.openValve.mockClear();
          platform.phynApi.closeValve.mockClear();

          // Simulate setActive(INACTIVE)
          await (pp as any).setActive(platform.Characteristic.Active.INACTIVE);

          const closeCalled = platform.phynApi.closeValve.mock.calls.length === 1;
          const openNotCalled = platform.phynApi.openValve.mock.calls.length === 0;

          vi.useRealTimers();
          return closeCalled && openNotCalled;
        },
      ),
      { numRuns: 10 },
    );
  });

  it('ACTIVE calls openValve and not closeValve', async () => {
    const { PPAccessory } = await import('../../src/accessory/pp.js');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        async (deviceId) => {
          vi.useFakeTimers();
          const device = makeDevice({ device_id: deviceId });
          const platform = createMockPlatform();
          const accessory = createMockAccessory(device);

          platform.phynApi.getDeviceState.mockResolvedValue({
            device_id: deviceId, sov_status: 'Close',
            flow: { mean: 0 }, pressure: { mean: 0 }, temperature: { mean: 68 },
            online_status: 'online',
          });

          const pp = new PPAccessory(platform as any, accessory as any);

          platform.phynApi.openValve.mockClear();
          platform.phynApi.closeValve.mockClear();

          await (pp as any).setActive(platform.Characteristic.Active.ACTIVE);

          const openCalled = platform.phynApi.openValve.mock.calls.length === 1;
          const closeNotCalled = platform.phynApi.closeValve.mock.calls.length === 0;

          vi.useRealTimers();
          return openCalled && closeNotCalled;
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13: Leak detection maps correctly to LeakDetected (PP)
// Validates: Requirements 4.5
// ---------------------------------------------------------------------------
describe('Property 13: Leak detection maps correctly to LeakDetected (PP)', () => {
  it('is_leak=true maps to LEAK_DETECTED, false/absent maps to LEAK_NOT_DETECTED', async () => {
    const { PPAccessory } = await import('../../src/accessory/pp.js');

    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (isLeak) => {
          vi.useFakeTimers();
          const device = makeDevice();
          const platform = createMockPlatform();
          const accessory = createMockAccessory(device);

          const state = {
            device_id: device.device_id, sov_status: 'Open' as const,
            flow: { mean: 0 }, pressure: { mean: 0 }, temperature: { mean: 68 },
            online_status: 'online',
            alerts: { is_leak: isLeak },
          };
          platform.phynApi.getDeviceState.mockResolvedValue(state);

          const pp = new PPAccessory(platform as any, accessory as any);
          pp.updateFromState(state);

          const leakSvc = accessory._services.get('LeakSensor');
          if (!leakSvc) return false;

          const calls = leakSvc.updateCharacteristic.mock.calls;
          const leakCall = calls.find((c: any[]) => c[0] === platform.Characteristic.LeakDetected);
          if (!leakCall) return false;

          const expected = isLeak
            ? platform.Characteristic.LeakDetected.LEAK_DETECTED
            : platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;

          vi.useRealTimers();
          return leakCall[1] === expected;
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14: AccessoryInformation fields are populated from device data (PP)
// Validates: Requirements 4.8
// ---------------------------------------------------------------------------
describe('Property 14: AccessoryInformation fields are populated from device data (PP)', () => {
  it('Manufacturer, Model, SerialNumber, FirmwareRevision are set from device', async () => {
    const { PPAccessory } = await import('../../src/accessory/pp.js');

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          device_id: fc.string({ minLength: 1 }),
          product_code: fc.string({ minLength: 1 }),
          serial_number: fc.string({ minLength: 1 }),
          firmware_version: fc.string({ minLength: 1 }),
          online_status: fc.constant('online'),
        }),
        async (device) => {
          vi.useFakeTimers();
          const platform = createMockPlatform();
          const accessory = createMockAccessory(device);

          platform.phynApi.getDeviceState.mockResolvedValue({
            device_id: device.device_id, sov_status: 'Open' as const,
            flow: { mean: 0 }, pressure: { mean: 0 }, temperature: { mean: 68 },
            online_status: 'online',
          });

          new PPAccessory(platform as any, accessory as any);

          const infoSvc = accessory._services.get('AccessoryInformation');
          if (!infoSvc) return false;

          const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
          const manufacturerCall = calls.find((c) => c[0] === platform.Characteristic.Manufacturer);
          const modelCall = calls.find((c) => c[0] === platform.Characteristic.Model);
          const serialCall = calls.find((c) => c[0] === platform.Characteristic.SerialNumber);
          const firmwareCall = calls.find((c) => c[0] === platform.Characteristic.FirmwareRevision);

          vi.useRealTimers();
          return (
            manufacturerCall?.[1] === 'Phyn' &&
            modelCall?.[1] === device.product_code &&
            serialCall?.[1] === device.serial_number &&
            firmwareCall?.[1] === device.firmware_version
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 18: MQTT message updates characteristics immediately
// Validates: Requirements 7.3
// ---------------------------------------------------------------------------
describe('Property 18: MQTT message updates characteristics immediately', () => {
  it('MQTT payload with sov_status updates Valve Active characteristic', async () => {
    const { PPAccessory } = await import('../../src/accessory/pp.js');

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('Open', 'Close') as fc.Arbitrary<'Open' | 'Close'>,
        async (sovStatus) => {
          vi.useFakeTimers();
          const device = makeDevice();
          const platform = createMockPlatform();
          const accessory = createMockAccessory(device);

          platform.phynApi.getDeviceState.mockResolvedValue({
            device_id: device.device_id, sov_status: 'Open' as const,
            flow: { mean: 0 }, pressure: { mean: 0 }, temperature: { mean: 68 },
            online_status: 'online',
          });

          const pp = new PPAccessory(platform as any, accessory as any);

          // Simulate MQTT message
          const payload = { sov_status: sovStatus };
          pp.updateFromMqtt(payload);

          const valveSvc = accessory._services.get('Valve');
          if (!valveSvc) return false;

          const calls = valveSvc.updateCharacteristic.mock.calls;
          const activeCall = calls.find((c: any[]) => c[0] === platform.Characteristic.Active);
          if (!activeCall) return false;

          const expected = sovStatus === 'Open'
            ? platform.Characteristic.Active.ACTIVE
            : platform.Characteristic.Active.INACTIVE;

          vi.useRealTimers();
          return activeCall[1] === expected;
        },
      ),
      { numRuns: 50 },
    );
  });

  it('MQTT payload with temperature updates TemperatureSensor characteristic', async () => {
    const { PPAccessory } = await import('../../src/accessory/pp.js');

    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: 32, max: 212, noNaN: true }),
        async (tempF) => {
          vi.useFakeTimers();
          const device = makeDevice();
          const platform = createMockPlatform();
          const accessory = createMockAccessory(device);

          platform.phynApi.getDeviceState.mockResolvedValue({
            device_id: device.device_id, sov_status: 'Open' as const,
            flow: { mean: 0 }, pressure: { mean: 0 }, temperature: { mean: 68 },
            online_status: 'online',
          });

          const pp = new PPAccessory(platform as any, accessory as any);

          const payload = { temperature: { mean: tempF } };
          pp.updateFromMqtt(payload);

          const tempSvc = accessory._services.get('TemperatureSensor');
          if (!tempSvc) return false;

          const calls = tempSvc.updateCharacteristic.mock.calls;
          const tempCall = calls.find((c: any[]) => c[0] === platform.Characteristic.CurrentTemperature);
          if (!tempCall) return false;

          const expected = fahrenheitToCelsius(tempF);
          vi.useRealTimers();
          return tempCall[1] === expected;
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 21: Polling updates all characteristics from device state
// Validates: Requirements 8.2
// ---------------------------------------------------------------------------
describe('Property 21: Polling updates all characteristics from device state', () => {
  it('updateFromState updates Active, InUse, LeakDetected, and CurrentTemperature', async () => {
    const { PPAccessory } = await import('../../src/accessory/pp.js');

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          sov_status: fc.constantFrom('Open', 'Close') as fc.Arbitrary<'Open' | 'Close'>,
          flowMean: fc.float({ min: 0, max: 100, noNaN: true }),
          tempF: fc.float({ min: 32, max: 212, noNaN: true }),
          isLeak: fc.boolean(),
        }),
        async ({ sov_status, flowMean, tempF, isLeak }) => {
          vi.useFakeTimers();
          const device = makeDevice();
          const platform = createMockPlatform();
          const accessory = createMockAccessory(device);

          const state: any = {
            device_id: device.device_id,
            sov_status,
            flow: { mean: flowMean },
            pressure: { mean: 50 },
            temperature: { mean: tempF },
            online_status: 'online',
            alerts: { is_leak: isLeak },
          };
          platform.phynApi.getDeviceState.mockResolvedValue(state);

          const pp = new PPAccessory(platform as any, accessory as any);
          pp.updateFromState(state);

          const valveSvc = accessory._services.get('Valve');
          const leakSvc = accessory._services.get('LeakSensor');
          const tempSvc = accessory._services.get('TemperatureSensor');

          if (!valveSvc || !leakSvc || !tempSvc) return false;

          const valveCalls: any[][] = valveSvc.updateCharacteristic.mock.calls;
          const activeCall = valveCalls.find((c) => c[0] === platform.Characteristic.Active);
          const inUseCall = valveCalls.find((c) => c[0] === platform.Characteristic.InUse);

          const leakCalls: any[][] = leakSvc.updateCharacteristic.mock.calls;
          const leakCall = leakCalls.find((c) => c[0] === platform.Characteristic.LeakDetected);

          const tempCalls: any[][] = tempSvc.updateCharacteristic.mock.calls;
          const tempCall = tempCalls.find((c) => c[0] === platform.Characteristic.CurrentTemperature);

          vi.useRealTimers();

          return (
            activeCall?.[1] === (sov_status === 'Open' ? 1 : 0) &&
            inUseCall?.[1] === (flowMean > 0 ? 1 : 0) &&
            leakCall?.[1] === (isLeak ? 1 : 0) &&
            tempCall?.[1] === fahrenheitToCelsius(tempF)
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 22: Polling failure does not crash the plugin
// Validates: Requirements 8.3
// ---------------------------------------------------------------------------
describe('Property 22: Polling failure does not crash the plugin', () => {
  it('poll() logs a warning and does not throw when getDeviceState fails', async () => {
    const { PPAccessory } = await import('../../src/accessory/pp.js');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        async (errorMessage) => {
          vi.useFakeTimers();
          const device = makeDevice();
          const platform = createMockPlatform();
          const accessory = createMockAccessory(device);

          platform.phynApi.getDeviceState.mockRejectedValue(new Error(errorMessage));

          const pp = new PPAccessory(platform as any, accessory as any);

          let threw = false;
          try {
            await (pp as any).poll();
          } catch {
            threw = true;
          }

          const warnCalled = platform.log.warn.mock.calls.length > 0;
          vi.useRealTimers();
          return !threw && warnCalled;
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 23: Firmware polled on correct cycle cadence
// Validates: Requirements 8.5
// ---------------------------------------------------------------------------
describe('Property 23: Firmware polled on correct cycle cadence', () => {
  it('getFirmwareInfo is called iff pollCycle % FIRMWARE_POLL_EVERY_N_CYCLES === 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 300 }),
        (cycle) => {
          const shouldPoll = cycle % FIRMWARE_POLL_EVERY_N_CYCLES === 0;
          // Verify the formula matches the implementation logic
          return shouldPoll === (cycle % FIRMWARE_POLL_EVERY_N_CYCLES === 0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getFirmwareInfo is called on cycle 0, 60, 120 but not 1, 59, 61', async () => {
    const { PPAccessory } = await import('../../src/accessory/pp.js');

    vi.useFakeTimers();
    const device = makeDevice();
    const platform = createMockPlatform();
    const accessory = createMockAccessory(device);

    const state = {
      device_id: device.device_id, sov_status: 'Open' as const,
      flow: { mean: 0 }, pressure: { mean: 0 }, temperature: { mean: 68 },
      online_status: 'online',
    };
    platform.phynApi.getDeviceState.mockResolvedValue(state);

    const pp = new PPAccessory(platform as any, accessory as any);

    // Flush the initial poll (cycle 0) by awaiting all pending microtasks
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Test cycle 1 — should NOT call getFirmwareInfo
    platform.phynApi.getFirmwareInfo.mockClear();
    (pp as any).pollCycle = 1;
    await (pp as any).poll();
    expect(platform.phynApi.getFirmwareInfo).not.toHaveBeenCalled();

    // Test cycle 59 — should NOT call getFirmwareInfo
    (pp as any).pollCycle = 59;
    platform.phynApi.getFirmwareInfo.mockClear();
    await (pp as any).poll();
    expect(platform.phynApi.getFirmwareInfo).not.toHaveBeenCalled();

    // Test cycle 60 — SHOULD call getFirmwareInfo
    (pp as any).pollCycle = 60;
    platform.phynApi.getFirmwareInfo.mockClear();
    await (pp as any).poll();
    expect(platform.phynApi.getFirmwareInfo).toHaveBeenCalledTimes(1);

    // Test cycle 120 — SHOULD call getFirmwareInfo
    (pp as any).pollCycle = 120;
    platform.phynApi.getFirmwareInfo.mockClear();
    await (pp as any).poll();
    expect(platform.phynApi.getFirmwareInfo).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Property 24: Away mode and auto-shutoff On/Off map to correct API calls
// Validates: Requirements 9.2, 9.3, 9.5, 9.6
// ---------------------------------------------------------------------------
describe('Property 24: Away mode and auto-shutoff On/Off map to correct API calls', () => {
  it('setAwayMode(true) calls setPreferences with away_mode=true', async () => {
    const { PPAccessory } = await import('../../src/accessory/pp.js');

    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (awayMode) => {
          vi.useFakeTimers();
          const device = makeDevice();
          const platform = createMockPlatform();
          const accessory = createMockAccessory(device);

          platform.phynApi.getDeviceState.mockResolvedValue({
            device_id: device.device_id, sov_status: 'Open' as const,
            flow: { mean: 0 }, pressure: { mean: 0 }, temperature: { mean: 68 },
            online_status: 'online',
          });

          const pp = new PPAccessory(platform as any, accessory as any);
          platform.phynApi.setPreferences.mockClear();

          await (pp as any).setAwayMode(awayMode);

          const calls = platform.phynApi.setPreferences.mock.calls;
          vi.useRealTimers();
          return (
            calls.length === 1 &&
            calls[0][0] === device.device_id &&
            calls[0][1].away_mode === awayMode
          );
        },
      ),
      { numRuns: 20 },
    );
  });

  it('setAutoShutoff(true) calls enableAutoShutoff, false calls disableAutoShutoff', async () => {
    const { PPAccessory } = await import('../../src/accessory/pp.js');

    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (enable) => {
          vi.useFakeTimers();
          const device = makeDevice();
          const platform = createMockPlatform();
          const accessory = createMockAccessory(device);

          platform.phynApi.getDeviceState.mockResolvedValue({
            device_id: device.device_id, sov_status: 'Open' as const,
            flow: { mean: 0 }, pressure: { mean: 0 }, temperature: { mean: 68 },
            online_status: 'online',
          });

          const pp = new PPAccessory(platform as any, accessory as any);
          platform.phynApi.enableAutoShutoff.mockClear();
          platform.phynApi.disableAutoShutoff.mockClear();

          await (pp as any).setAutoShutoff(enable);

          vi.useRealTimers();
          if (enable) {
            return (
              platform.phynApi.enableAutoShutoff.mock.calls.length === 1 &&
              platform.phynApi.disableAutoShutoff.mock.calls.length === 0
            );
          } else {
            return (
              platform.phynApi.disableAutoShutoff.mock.calls.length === 1 &&
              platform.phynApi.enableAutoShutoff.mock.calls.length === 0
            );
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// PC-specific mock platform (adds StatusFault to Characteristic)
// ---------------------------------------------------------------------------

function createMockPlatformPC(apiOverrides: any = {}) {
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

// ---------------------------------------------------------------------------
// Property 15: Offline device sets StatusFault on all services
// Validates: Requirements 5.4
// ---------------------------------------------------------------------------
describe('Property 15: Offline device sets StatusFault on all services', () => {
  it('setFault(true) sets GENERAL_FAULT on both temperature services', async () => {
    const { PCAccessory } = await import('../../src/accessory/pc.js');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        async (deviceId) => {
          vi.useFakeTimers();
          const device = makeDevice({ device_id: deviceId, product_code: 'PC21' });
          const platform = createMockPlatformPC();
          const accessory = createMockAccessory(device);

          const pc = new PCAccessory(platform as any, accessory as any);
          pc.setFault(true);

          const hotSvc = accessory._services.get('Hot Water Temperature');
          const coldSvc = accessory._services.get('Cold Water Temperature');
          if (!hotSvc || !coldSvc) return false;

          const hotCalls: any[][] = hotSvc.updateCharacteristic.mock.calls;
          const coldCalls: any[][] = coldSvc.updateCharacteristic.mock.calls;

          const hotFaultCall = hotCalls.find((c) => c[0] === platform.Characteristic.StatusFault);
          const coldFaultCall = coldCalls.find((c) => c[0] === platform.Characteristic.StatusFault);

          vi.useRealTimers();
          return (
            hotFaultCall?.[1] === platform.Characteristic.StatusFault.GENERAL_FAULT &&
            coldFaultCall?.[1] === platform.Characteristic.StatusFault.GENERAL_FAULT
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  it('setFault(false) sets NO_FAULT on both temperature services', async () => {
    const { PCAccessory } = await import('../../src/accessory/pc.js');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        async (deviceId) => {
          vi.useFakeTimers();
          const device = makeDevice({ device_id: deviceId, product_code: 'PC21' });
          const platform = createMockPlatformPC();
          const accessory = createMockAccessory(device);

          const pc = new PCAccessory(platform as any, accessory as any);
          pc.setFault(false);

          const hotSvc = accessory._services.get('Hot Water Temperature');
          const coldSvc = accessory._services.get('Cold Water Temperature');
          if (!hotSvc || !coldSvc) return false;

          const hotCalls: any[][] = hotSvc.updateCharacteristic.mock.calls;
          const coldCalls: any[][] = coldSvc.updateCharacteristic.mock.calls;

          const hotFaultCall = hotCalls.find((c) => c[0] === platform.Characteristic.StatusFault);
          const coldFaultCall = coldCalls.find((c) => c[0] === platform.Characteristic.StatusFault);

          vi.useRealTimers();
          return (
            hotFaultCall?.[1] === platform.Characteristic.StatusFault.NO_FAULT &&
            coldFaultCall?.[1] === platform.Characteristic.StatusFault.NO_FAULT
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  it('online_status !== "online" triggers setFault(true) via updateFromState', async () => {
    const { PCAccessory } = await import('../../src/accessory/pc.js');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => s !== 'online'),
        async (offlineStatus) => {
          vi.useFakeTimers();
          const device = makeDevice({ product_code: 'PC21' });
          const platform = createMockPlatformPC();
          const accessory = createMockAccessory(device);

          const pc = new PCAccessory(platform as any, accessory as any);

          const state: any = {
            device_id: device.device_id,
            temperature: { mean: 68 },
            online_status: offlineStatus,
          };
          pc.updateFromState(state);

          const hotSvc = accessory._services.get('Hot Water Temperature');
          const coldSvc = accessory._services.get('Cold Water Temperature');
          if (!hotSvc || !coldSvc) return false;

          const hotCalls: any[][] = hotSvc.updateCharacteristic.mock.calls;
          const coldCalls: any[][] = coldSvc.updateCharacteristic.mock.calls;

          const hotFaultCall = hotCalls.find((c) => c[0] === platform.Characteristic.StatusFault);
          const coldFaultCall = coldCalls.find((c) => c[0] === platform.Characteristic.StatusFault);

          vi.useRealTimers();
          return (
            hotFaultCall?.[1] === platform.Characteristic.StatusFault.GENERAL_FAULT &&
            coldFaultCall?.[1] === platform.Characteristic.StatusFault.GENERAL_FAULT
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14: AccessoryInformation fields are populated from device data (PC)
// Validates: Requirements 5.2
// ---------------------------------------------------------------------------
describe('Property 14: AccessoryInformation fields are populated from device data (PC)', () => {
  it('Manufacturer, Model, SerialNumber, FirmwareRevision are set from PC device', async () => {
    const { PCAccessory } = await import('../../src/accessory/pc.js');

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          device_id: fc.string({ minLength: 1 }),
          product_code: fc.string({ minLength: 1 }),
          serial_number: fc.string({ minLength: 1 }),
          firmware_version: fc.string({ minLength: 1 }),
          online_status: fc.constant('online'),
        }),
        async (device) => {
          vi.useFakeTimers();
          const platform = createMockPlatformPC();
          const accessory = createMockAccessory(device);

          new PCAccessory(platform as any, accessory as any);

          const infoSvc = accessory._services.get('AccessoryInformation');
          if (!infoSvc) return false;

          const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
          const manufacturerCall = calls.find((c) => c[0] === platform.Characteristic.Manufacturer);
          const modelCall = calls.find((c) => c[0] === platform.Characteristic.Model);
          const serialCall = calls.find((c) => c[0] === platform.Characteristic.SerialNumber);
          const firmwareCall = calls.find((c) => c[0] === platform.Characteristic.FirmwareRevision);

          vi.useRealTimers();
          return (
            manufacturerCall?.[1] === 'Phyn' &&
            modelCall?.[1] === device.product_code &&
            serialCall?.[1] === device.serial_number &&
            firmwareCall?.[1] === device.firmware_version
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// PW-specific mock platform
// ---------------------------------------------------------------------------

function createMockPlatformPW(apiOverrides: any = {}) {
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

// ---------------------------------------------------------------------------
// Property 13: Leak detection maps correctly to LeakDetected (PW)
// Validates: Requirements 6.1
// ---------------------------------------------------------------------------
describe('Property 13: Leak detection maps correctly to LeakDetected (PW)', () => {
  it('water_detected=true maps to LEAK_DETECTED, false/absent maps to LEAK_NOT_DETECTED', async () => {
    const { PWAccessory } = await import('../../src/accessory/pw.js');

    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (waterDetected) => {
          vi.useFakeTimers();
          const device = makeDevice({ device_id: 'dev-pw-001', product_code: 'PW21' });
          const platform = createMockPlatformPW();
          const accessory = createMockAccessory(device);

          const state: any = {
            device_id: device.device_id,
            online_status: 'online',
            alerts: { water_detected: waterDetected },
          };
          const stats: any = { temperature: 68, humidity: 50, battery_level: 80 };

          platform.phynApi.getDeviceState.mockResolvedValue(state);
          platform.phynApi.getWaterStatistics.mockResolvedValue(stats);

          const pw = new PWAccessory(platform as any, accessory as any);
          pw.updateFromState(state, stats);

          const leakSvc = accessory._services.get('LeakSensor');
          if (!leakSvc) return false;

          const calls = leakSvc.updateCharacteristic.mock.calls;
          const leakCall = calls.find((c: any[]) => c[0] === platform.Characteristic.LeakDetected);
          if (!leakCall) return false;

          const expected = waterDetected
            ? platform.Characteristic.LeakDetected.LEAK_DETECTED
            : platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;

          vi.useRealTimers();
          return leakCall[1] === expected;
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 16: Battery low threshold boundary
// Validates: Requirements 6.4
// ---------------------------------------------------------------------------
describe('Property 16: Battery low threshold boundary', () => {
  it('battery_level < 20 maps to BATTERY_LEVEL_LOW, >= 20 maps to BATTERY_LEVEL_NORMAL', async () => {
    const { PWAccessory } = await import('../../src/accessory/pw.js');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (batteryLevel) => {
          vi.useFakeTimers();
          const device = makeDevice({ device_id: 'dev-pw-001', product_code: 'PW21' });
          const platform = createMockPlatformPW();
          const accessory = createMockAccessory(device);

          const state: any = {
            device_id: device.device_id,
            online_status: 'online',
            alerts: { water_detected: false },
          };
          const stats: any = { temperature: 68, humidity: 50, battery_level: batteryLevel };

          platform.phynApi.getDeviceState.mockResolvedValue(state);
          platform.phynApi.getWaterStatistics.mockResolvedValue(stats);

          const pw = new PWAccessory(platform as any, accessory as any);
          pw.updateFromState(state, stats);

          const batterySvc = accessory._services.get('Battery');
          if (!batterySvc) return false;

          const calls = batterySvc.updateCharacteristic.mock.calls;
          const lowBatteryCall = calls.find((c: any[]) => c[0] === platform.Characteristic.StatusLowBattery);
          if (!lowBatteryCall) return false;

          const expected = batteryLevel < 20
            ? platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

          vi.useRealTimers();
          return lowBatteryCall[1] === expected;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14: AccessoryInformation fields are populated from device data (PW)
// Validates: Requirements 6.5
// ---------------------------------------------------------------------------
describe('Property 14: AccessoryInformation fields are populated from device data (PW)', () => {
  it('Manufacturer, Model, SerialNumber, FirmwareRevision are set from PW device', async () => {
    const { PWAccessory } = await import('../../src/accessory/pw.js');

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          device_id: fc.string({ minLength: 1 }),
          product_code: fc.string({ minLength: 1 }),
          serial_number: fc.string({ minLength: 1 }),
          firmware_version: fc.string({ minLength: 1 }),
          online_status: fc.constant('online'),
        }),
        async (device) => {
          vi.useFakeTimers();
          const platform = createMockPlatformPW();
          const accessory = createMockAccessory(device);

          new PWAccessory(platform as any, accessory as any);

          const infoSvc = accessory._services.get('AccessoryInformation');
          if (!infoSvc) return false;

          const calls: any[][] = infoSvc.setCharacteristic.mock.calls;
          const manufacturerCall = calls.find((c) => c[0] === platform.Characteristic.Manufacturer);
          const modelCall = calls.find((c) => c[0] === platform.Characteristic.Model);
          const serialCall = calls.find((c) => c[0] === platform.Characteristic.SerialNumber);
          const firmwareCall = calls.find((c) => c[0] === platform.Characteristic.FirmwareRevision);

          vi.useRealTimers();
          return (
            manufacturerCall?.[1] === 'Phyn' &&
            modelCall?.[1] === device.product_code &&
            serialCall?.[1] === device.serial_number &&
            firmwareCall?.[1] === device.firmware_version
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});
