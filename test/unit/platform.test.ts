import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock accessory classes
vi.mock('../../src/accessory/pp.js', () => ({ PPAccessory: vi.fn() }));
vi.mock('../../src/accessory/pc.js', () => ({ PCAccessory: vi.fn() }));
vi.mock('../../src/accessory/pw.js', () => ({ PWAccessory: vi.fn() }));

// Mock PhynApi
const mockAuthenticate = vi.fn();
const mockGetHomes = vi.fn();
const mockGetDevices = vi.fn();
const mockGetIotPolicy = vi.fn();

vi.mock('../../src/api/phynApi.js', () => ({
  PhynApi: vi.fn().mockImplementation(() => ({
    authenticate: mockAuthenticate,
    getHomes: mockGetHomes,
    getDevices: mockGetDevices,
    getIotPolicy: mockGetIotPolicy,
  })),
  AuthError: class AuthError extends Error {
    constructor(msg: string) { super(msg); this.name = 'AuthError'; }
  },
  NetworkError: class NetworkError extends Error {
    constructor(msg: string) { super(msg); this.name = 'NetworkError'; }
  },
}));

// Mock MqttClient
const mockMqttConnect = vi.fn();
vi.mock('../../src/api/mqttClient.js', () => ({
  MqttClient: vi.fn().mockImplementation(() => ({
    connect: mockMqttConnect,
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

describe('PhynPlatform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue(undefined);
    mockGetHomes.mockResolvedValue([]);
    mockGetDevices.mockResolvedValue([]);
    mockGetIotPolicy.mockResolvedValue({ wss_url: 'wss://test.example.com', user_id: 'user1' });
    mockMqttConnect.mockResolvedValue(undefined);
  });

  describe('constructor', () => {
    it('registers didFinishLaunching event handler', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };

      new PhynPlatform(log as any, config as any, api as any);

      expect(api.on).toHaveBeenCalledWith('didFinishLaunching', expect.any(Function));
    });

    it('instantiates PhynApi and MqttClient', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const { PhynApi } = await import('../../src/api/phynApi.js');
      const { MqttClient } = await import('../../src/api/mqttClient.js');

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };

      const platform = new PhynPlatform(log as any, config as any, api as any);

      expect(PhynApi).toHaveBeenCalledWith(log, config);
      expect(MqttClient).toHaveBeenCalledWith(log);
      expect(platform.phynApi).toBeDefined();
      expect(platform.mqttClient).toBeDefined();
    });
  });

  describe('configureAccessory()', () => {
    it('stores accessory in the accessories map by UUID', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      const mockAccessory = { displayName: 'Test Device', UUID: 'test-uuid-123', context: {} };
      platform.configureAccessory(mockAccessory as any);

      expect(platform.accessories.get('test-uuid-123')).toBe(mockAccessory);
    });

    it('logs info when loading accessory from cache', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      const mockAccessory = { displayName: 'My Device', UUID: 'some-uuid', context: {} };
      platform.configureAccessory(mockAccessory as any);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('My Device'));
    });
  });

  describe('discoverDevices() — config validation', () => {
    it('logs error and returns early when username is missing', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('username'));
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('logs error and returns early when password is missing', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('password'));
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('logs error and returns early for invalid brand', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p', brand: 'invalid' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('brand'));
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('accepts valid brand "phyn"', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p', brand: 'phyn' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(mockAuthenticate).toHaveBeenCalled();
    });

    it('accepts valid brand "kohler"', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p', brand: 'kohler' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(mockAuthenticate).toHaveBeenCalled();
    });
  });

  describe('discoverDevices() — auth success flow', () => {
    it('calls authenticate() before getHomes()', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const callOrder: string[] = [];
      mockAuthenticate.mockImplementation(async () => { callOrder.push('authenticate'); });
      mockGetHomes.mockImplementation(async () => { callOrder.push('getHomes'); return []; });

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(callOrder.indexOf('authenticate')).toBeLessThan(callOrder.indexOf('getHomes'));
    });

    it('calls getHomes() after successful authentication', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(mockAuthenticate).toHaveBeenCalledOnce();
      expect(mockGetHomes).toHaveBeenCalledOnce();
    });

    it('calls getDevices() for each home returned', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      mockGetHomes.mockResolvedValue([
        { id: 'home1', name: 'Home 1' },
        { id: 'home2', name: 'Home 2' },
      ]);

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(mockGetDevices).toHaveBeenCalledTimes(2);
      expect(mockGetDevices).toHaveBeenCalledWith('home1');
      expect(mockGetDevices).toHaveBeenCalledWith('home2');
    });

    it('registers new accessories for discovered devices', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      mockGetHomes.mockResolvedValue([{ id: 'home1', name: 'Home 1' }]);
      mockGetDevices.mockResolvedValue([
        { device_id: 'dev1', product_code: 'PP21', serial_number: 'SN1', firmware_version: '1.0', online_status: 'online' },
      ]);

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(api.registerPlatformAccessories).toHaveBeenCalledOnce();
    });
  });

  describe('discoverDevices() — auth failure flow', () => {
    it('logs error and does not call getHomes() when authenticate() throws', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      mockAuthenticate.mockRejectedValue(new Error('Invalid credentials'));

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Authentication failed'));
      expect(mockGetHomes).not.toHaveBeenCalled();
    });

    it('does not throw unhandled exception when auth fails', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      mockAuthenticate.mockRejectedValue(new Error('Network error'));

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      // Should not throw
      await expect(platform.discoverDevices()).resolves.toBeUndefined();
    });
  });

  describe('discoverDevices() — MQTT connection', () => {
    it('calls mqttClient.connect() with WSS URL from getIotPolicy() after auth', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const wssUrl = 'wss://mqtt.phyn.com/mqtt';
      mockGetIotPolicy.mockResolvedValue({ wss_url: wssUrl, user_id: 'user1' });

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(mockMqttConnect).toHaveBeenCalledWith(wssUrl);
    });

    it('calls getIotPolicy() with the username from config', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'myuser@example.com', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(mockGetIotPolicy).toHaveBeenCalledWith('myuser@example.com');
    });

    it('logs error but does not crash when MQTT connect fails', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      mockMqttConnect.mockRejectedValue(new Error('MQTT connection refused'));

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await expect(platform.discoverDevices()).resolves.toBeUndefined();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('MQTT'));
    });

    it('does not call mqttClient.connect() when auth fails', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      mockAuthenticate.mockRejectedValue(new Error('Auth failed'));

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(mockMqttConnect).not.toHaveBeenCalled();
    });
  });

  describe('discoverDevices() — device type routing', () => {
    it('instantiates PPAccessory for PP product codes', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const { PPAccessory } = await import('../../src/accessory/pp.js');

      vi.clearAllMocks();
      mockAuthenticate.mockResolvedValue(undefined);
      mockGetHomes.mockResolvedValue([{ id: 'home1', name: 'Home' }]);
      mockGetDevices.mockResolvedValue([
        { device_id: 'pp-dev', product_code: 'PP21', serial_number: 'SN1', firmware_version: '1.0', online_status: 'online' },
      ]);
      mockGetIotPolicy.mockResolvedValue({ wss_url: 'wss://test', user_id: 'user1' });
      mockMqttConnect.mockResolvedValue(undefined);

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(PPAccessory).toHaveBeenCalled();
    });

    it('instantiates PCAccessory for PC product codes', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const { PCAccessory } = await import('../../src/accessory/pc.js');

      vi.clearAllMocks();
      mockAuthenticate.mockResolvedValue(undefined);
      mockGetHomes.mockResolvedValue([{ id: 'home1', name: 'Home' }]);
      mockGetDevices.mockResolvedValue([
        { device_id: 'pc-dev', product_code: 'PC21', serial_number: 'SN2', firmware_version: '1.0', online_status: 'online' },
      ]);
      mockGetIotPolicy.mockResolvedValue({ wss_url: 'wss://test', user_id: 'user1' });
      mockMqttConnect.mockResolvedValue(undefined);

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(PCAccessory).toHaveBeenCalled();
    });

    it('instantiates PWAccessory for PW product codes', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');
      const { PWAccessory } = await import('../../src/accessory/pw.js');

      vi.clearAllMocks();
      mockAuthenticate.mockResolvedValue(undefined);
      mockGetHomes.mockResolvedValue([{ id: 'home1', name: 'Home' }]);
      mockGetDevices.mockResolvedValue([
        { device_id: 'pw-dev', product_code: 'PW21', serial_number: 'SN3', firmware_version: '1.0', online_status: 'online' },
      ]);
      mockGetIotPolicy.mockResolvedValue({ wss_url: 'wss://test', user_id: 'user1' });
      mockMqttConnect.mockResolvedValue(undefined);

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(PWAccessory).toHaveBeenCalled();
    });

    it('logs warning for unknown device type', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');

      vi.clearAllMocks();
      mockAuthenticate.mockResolvedValue(undefined);
      mockGetHomes.mockResolvedValue([{ id: 'home1', name: 'Home' }]);
      mockGetDevices.mockResolvedValue([
        { device_id: 'unknown-dev', product_code: 'XY99', serial_number: 'SN4', firmware_version: '1.0', online_status: 'online' },
      ]);
      mockGetIotPolicy.mockResolvedValue({ wss_url: 'wss://test', user_id: 'user1' });
      mockMqttConnect.mockResolvedValue(undefined);

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      await platform.discoverDevices();

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('XY99'));
    });
  });

  describe('discoverDevices() — stale accessory cleanup', () => {
    it('unregisters stale accessories not returned by the API', async () => {
      const { PhynPlatform } = await import('../../src/platform.js');

      vi.clearAllMocks();
      mockAuthenticate.mockResolvedValue(undefined);
      mockGetHomes.mockResolvedValue([{ id: 'home1', name: 'Home' }]);
      mockGetDevices.mockResolvedValue([]);
      mockGetIotPolicy.mockResolvedValue({ wss_url: 'wss://test', user_id: 'user1' });
      mockMqttConnect.mockResolvedValue(undefined);

      const log = createMockLog();
      const api = createMockApi();
      const config = { platform: 'PhynPlatform', name: 'Phyn', username: 'u', password: 'p' };
      const platform = new PhynPlatform(log as any, config as any, api as any);

      const staleAccessory = { displayName: 'Old Device', UUID: 'stale-uuid', context: {} };
      platform.accessories.set('stale-uuid', staleAccessory as any);

      await platform.discoverDevices();

      expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        [staleAccessory],
      );
    });
  });
});

describe('Plugin registration (index.ts)', () => {
  it('calls api.registerPlatform with PLATFORM_NAME and PhynPlatform', async () => {
    const { PhynPlatform } = await import('../../src/platform.js');
    const registerPlatform = vi.fn();
    const mockApi = { registerPlatform } as any;

    const { default: initPlugin } = await import('../../src/index.js');
    initPlugin(mockApi);

    expect(registerPlatform).toHaveBeenCalledWith('PhynPlatform', PhynPlatform);
  });
});

describe('config.schema.json', () => {
  it('parses as valid JSON', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const schemaPath = resolve(__dirname, '../../config.schema.json');
    const raw = readFileSync(schemaPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('has pluginAlias "PhynPlatform"', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const schemaPath = resolve(__dirname, '../../config.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    expect(schema.pluginAlias).toBe('PhynPlatform');
  });

  it('has pluginType "platform"', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const schemaPath = resolve(__dirname, '../../config.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    expect(schema.pluginType).toBe('platform');
  });
});
