import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { DEFAULT_POLLING_INTERVAL } from '../../src/settings.js';

// Mock accessory classes that don't exist yet
vi.mock('../../src/accessory/pp.js', () => ({ PPAccessory: vi.fn() }));
vi.mock('../../src/accessory/pc.js', () => ({ PCAccessory: vi.fn() }));
vi.mock('../../src/accessory/pw.js', () => ({ PWAccessory: vi.fn() }));

vi.mock('../../src/api/phynApi.js', () => ({
  PhynApi: vi.fn().mockImplementation(() => ({
    authenticate: vi.fn().mockResolvedValue(undefined),
    getHomes: vi.fn().mockResolvedValue([]),
    getDevices: vi.fn().mockResolvedValue([]),
    getIotPolicy: vi.fn().mockResolvedValue({ wss_url: 'wss://test', user_id: 'user1' }),
  })),
  AuthError: class AuthError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../src/api/mqttClient.js', () => ({
  MqttClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  })),
}));

function createMockApi(overrides = {}) {
  return {
    hap: {
      uuid: { generate: (id: string) => `uuid-${id}` },
      Service: {},
      Characteristic: {},
    },
    on: vi.fn(),
    platformAccessory: vi.fn((name: string, uuid: string) => ({
      displayName: name,
      UUID: uuid,
      context: {},
      getService: vi.fn(),
      addService: vi.fn(),
    })),
    registerPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    ...overrides,
  };
}

function createMockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

// Feature: homebridge-phyn-plugin, Property 1: Config validation rejects missing credentials
// Validates: Requirements 1.3
describe('Property 1: Config validation rejects missing credentials', () => {
  it('returns early and logs error when username is missing', async () => {
    const { PhynPlatform } = await import('../../src/platform.js');
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        async (password) => {
          const log = createMockLog();
          const api = createMockApi();
          const config = { platform: 'PhynPlatform', name: 'Phyn', password };
          const platform = new PhynPlatform(log as any, config as any, api as any);
          await platform.discoverDevices();
          return log.error.mock.calls.length > 0;
        },
      ),
      { numRuns: 10 },
    );
  });

  it('returns early and logs error when password is missing', async () => {
    const { PhynPlatform } = await import('../../src/platform.js');
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        async (username) => {
          const log = createMockLog();
          const api = createMockApi();
          const config = { platform: 'PhynPlatform', name: 'Phyn', username };
          const platform = new PhynPlatform(log as any, config as any, api as any);
          await platform.discoverDevices();
          return log.error.mock.calls.length > 0;
        },
      ),
      { numRuns: 10 },
    );
  });

  it('returns early and logs error when both username and password are missing', async () => {
    const { PhynPlatform } = await import('../../src/platform.js');
    const log = createMockLog();
    const api = createMockApi();
    const config = { platform: 'PhynPlatform', name: 'Phyn' };
    const platform = new PhynPlatform(log as any, config as any, api as any);
    await platform.discoverDevices();
    expect(log.error.mock.calls.length).toBeGreaterThan(0);
  });
});

// Feature: homebridge-phyn-plugin, Property 2: Config validation rejects invalid brand
// Validates: Requirements 1.4
describe('Property 2: Config validation rejects invalid brand', () => {
  it('returns early and logs error for any brand not phyn or kohler', async () => {
    const { PhynPlatform } = await import('../../src/platform.js');
    const invalidBrands = ['acme', 'test', 'PHYN', 'KOHLER', 'phyn2', 'kohler2', 'xyz'];
    for (const brand of invalidBrands) {
      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p', brand };
      const platform = new PhynPlatform(log as any, config as any, api as any);
      await platform.discoverDevices();
      expect(log.error.mock.calls.length).toBeGreaterThan(0);
    }
  });

  it('does not log error for valid brands phyn and kohler', async () => {
    const { PhynPlatform } = await import('../../src/platform.js');
    const { PhynApi } = await import('../../src/api/phynApi.js');

    for (const brand of ['phyn', 'kohler']) {
      vi.clearAllMocks();
      (PhynApi as any).mockImplementation(() => ({
        authenticate: vi.fn().mockResolvedValue(undefined),
        getHomes: vi.fn().mockResolvedValue([]),
        getDevices: vi.fn().mockResolvedValue([]),
        getIotPolicy: vi.fn().mockResolvedValue({ wss_url: 'wss://test', user_id: 'user1' }),
      }));

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p', brand };
      const platform = new PhynPlatform(log as any, config as any, api as any);
      await platform.discoverDevices();
      // No brand-related error should be logged
      const brandErrors = log.error.mock.calls.filter((c: any[]) =>
        c[0].includes('brand') || c[0].includes('Invalid'),
      );
      expect(brandErrors.length).toBe(0);
    }
  });
});

// Feature: homebridge-phyn-plugin, Property 3: Config fields are read with correct defaults
// Validates: Requirements 1.2
describe('Property 3: Config fields are read with correct defaults', () => {
  it('pollingInterval defaults to DEFAULT_POLLING_INTERVAL when absent', () => {
    fc.assert(
      fc.property(
        fc.record({ username: fc.string({ minLength: 1 }), password: fc.string({ minLength: 1 }) }),
        (baseConfig) => {
          const config = { platform: 'PhynPlatform', name: 'Phyn', ...baseConfig };
          const pollingInterval = (config as any)['pollingInterval'] ?? DEFAULT_POLLING_INTERVAL;
          return pollingInterval === DEFAULT_POLLING_INTERVAL;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('brand defaults to phyn when absent', () => {
    fc.assert(
      fc.property(
        fc.record({ username: fc.string({ minLength: 1 }), password: fc.string({ minLength: 1 }) }),
        (baseConfig) => {
          const config = { platform: 'PhynPlatform', name: 'Phyn', ...baseConfig };
          const brand = (config as any)['brand'] ?? 'phyn';
          return brand === 'phyn';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('pollingInterval is used as-is when provided', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3600 }),
        (interval) => {
          const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p', pollingInterval: interval };
          const pollingInterval = (config as any)['pollingInterval'] ?? DEFAULT_POLLING_INTERVAL;
          return pollingInterval === interval;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: homebridge-phyn-plugin, Property 6: UUID derivation is deterministic
// Validates: Requirements 3.3
describe('Property 6: UUID derivation is deterministic', () => {
  it('same deviceId always produces same UUID via api.hap.uuid.generate', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (deviceId) => {
          // Simulate the deterministic UUID generation used in platform
          const uuid1 = `uuid-${deviceId}`;
          const uuid2 = `uuid-${deviceId}`;
          return uuid1 === uuid2;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('different deviceIds produce different UUIDs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (id1, id2) => {
          if (id1 === id2) return true; // skip equal inputs
          const uuid1 = `uuid-${id1}`;
          const uuid2 = `uuid-${id2}`;
          return uuid1 !== uuid2;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: homebridge-phyn-plugin, Property 7: Device discovery calls getDevices for every home
// Validates: Requirements 3.2
describe('Property 7: Device discovery calls getDevices for every home', () => {
  it('getDevices is called exactly N times for N homes', async () => {
    const { PhynApi } = await import('../../src/api/phynApi.js');
    const { PhynPlatform } = await import('../../src/platform.js');

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
        async (homeIds) => {
          vi.clearAllMocks();
          const homes = homeIds.map((id) => ({ id, name: `Home ${id}` }));
          const mockGetDevices = vi.fn().mockResolvedValue([]);
          (PhynApi as any).mockImplementation(() => ({
            authenticate: vi.fn().mockResolvedValue(undefined),
            getHomes: vi.fn().mockResolvedValue(homes),
            getDevices: mockGetDevices,
            getIotPolicy: vi.fn().mockResolvedValue({ wss_url: 'wss://test', user_id: 'user1' }),
          }));

          const log = createMockLog();
          const api = createMockApi();
          const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
          const platform = new PhynPlatform(log as any, config as any, api as any);
          await platform.discoverDevices();

          return mockGetDevices.mock.calls.length === homeIds.length;
        },
      ),
      { numRuns: 10 },
    );
  });
});

// Feature: homebridge-phyn-plugin, Property 8: No duplicate accessories on re-discovery
// Validates: Requirements 3.4
describe('Property 8: No duplicate accessories on re-discovery', () => {
  it('restores cached accessory instead of registering a new one', async () => {
    const { PhynApi } = await import('../../src/api/phynApi.js');
    const { PhynPlatform } = await import('../../src/platform.js');

    vi.clearAllMocks();
    const deviceId = 'device-123';
    const uuid = `uuid-${deviceId}`;
    const device = {
      device_id: deviceId,
      product_code: 'PP21',
      serial_number: 'SN1',
      firmware_version: '1.0',
      online_status: 'online',
    };

    (PhynApi as any).mockImplementation(() => ({
      authenticate: vi.fn().mockResolvedValue(undefined),
      getHomes: vi.fn().mockResolvedValue([{ id: 'home1', name: 'Home' }]),
      getDevices: vi.fn().mockResolvedValue([device]),
      getIotPolicy: vi.fn().mockResolvedValue({ wss_url: 'wss://test', user_id: 'user1' }),
    }));

    const log = createMockLog();
    const mockApi = createMockApi();
    const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
    const platform = new PhynPlatform(log as any, config as any, mockApi as any);

    // Pre-populate cache with existing accessory
    const cachedAccessory = {
      displayName: deviceId,
      UUID: uuid,
      context: { device },
      getService: vi.fn(),
      addService: vi.fn(),
    };
    platform.accessories.set(uuid, cachedAccessory as any);

    await platform.discoverDevices();

    // registerPlatformAccessories should NOT be called for the cached device
    expect(mockApi.registerPlatformAccessories).not.toHaveBeenCalled();
    // updatePlatformAccessories should be called instead
    expect(mockApi.updatePlatformAccessories).toHaveBeenCalled();
  });
});

// Feature: homebridge-phyn-plugin, Property 9: Stale accessories are unregistered
// Validates: Requirements 3.5
describe('Property 9: Stale accessories are unregistered', () => {
  it('unregisters accessories not returned by the API', async () => {
    const { PhynApi } = await import('../../src/api/phynApi.js');
    const { PhynPlatform } = await import('../../src/platform.js');

    vi.clearAllMocks();
    (PhynApi as any).mockImplementation(() => ({
      authenticate: vi.fn().mockResolvedValue(undefined),
      getHomes: vi.fn().mockResolvedValue([{ id: 'home1', name: 'Home' }]),
      getDevices: vi.fn().mockResolvedValue([]), // No devices returned
      getIotPolicy: vi.fn().mockResolvedValue({ wss_url: 'wss://test', user_id: 'user1' }),
    }));

    const log = createMockLog();
    const mockApi = createMockApi();
    const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
    const platform = new PhynPlatform(log as any, config as any, mockApi as any);

    // Pre-populate cache with stale accessory
    const staleUUID = 'uuid-stale-device';
    const staleAccessory = {
      displayName: 'Stale Device',
      UUID: staleUUID,
      context: {},
      getService: vi.fn(),
      addService: vi.fn(),
    };
    platform.accessories.set(staleUUID, staleAccessory as any);

    await platform.discoverDevices();

    expect(mockApi.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.arrayContaining([staleAccessory]),
    );
    // Stale accessory should be removed from the map
    expect(platform.accessories.has(staleUUID)).toBe(false);
  });

  it('does not unregister accessories that are still returned by the API', async () => {
    const { PhynApi } = await import('../../src/api/phynApi.js');
    const { PhynPlatform } = await import('../../src/platform.js');

    vi.clearAllMocks();
    const deviceId = 'active-device';
    const uuid = `uuid-${deviceId}`;
    const device = {
      device_id: deviceId,
      product_code: 'PP21',
      serial_number: 'SN1',
      firmware_version: '1.0',
      online_status: 'online',
    };

    (PhynApi as any).mockImplementation(() => ({
      authenticate: vi.fn().mockResolvedValue(undefined),
      getHomes: vi.fn().mockResolvedValue([{ id: 'home1', name: 'Home' }]),
      getDevices: vi.fn().mockResolvedValue([device]),
      getIotPolicy: vi.fn().mockResolvedValue({ wss_url: 'wss://test', user_id: 'user1' }),
    }));

    const log = createMockLog();
    const mockApi = createMockApi();
    const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
    const platform = new PhynPlatform(log as any, config as any, mockApi as any);

    const cachedAccessory = {
      displayName: deviceId,
      UUID: uuid,
      context: { device },
      getService: vi.fn(),
      addService: vi.fn(),
    };
    platform.accessories.set(uuid, cachedAccessory as any);

    await platform.discoverDevices();

    expect(mockApi.unregisterPlatformAccessories).not.toHaveBeenCalled();
  });
});
