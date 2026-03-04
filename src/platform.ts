import {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { PhynApi } from './api/phynApi.js';
import { MqttClient } from './api/mqttClient.js';
import { PPAccessory } from './accessory/pp.js';
import { PCAccessory } from './accessory/pc.js';
import { PWAccessory } from './accessory/pw.js';
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  MQTT_RECOVERY_INTERVAL_MS,
  DEVICE_DISCOVERY_INTERVAL_MS,
} from './settings.js';
import { detectDeviceType } from './utils.js';

type AccessoryController = {
  destroy?: () => void;
};

export class PhynPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  public readonly phynApi: PhynApi;
  public readonly mqttClient: MqttClient;
  private mqttRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private mqttRecoveryListenerRegistered = false;
  private discovering = false;
  private readonly accessoryControllers: Map<string, AccessoryController> = new Map();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.phynApi = new PhynApi(log, config);
    const userId = config['username'] as string;
    this.mqttClient = new MqttClient(log, async () => {
      const policy = await this.phynApi.getIotPolicy(userId);
      return policy.wss_url;
    });

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
      this.scheduleDailyDiscovery();
    });

    this.api.on('shutdown', () => {
      if (this.discoveryTimer !== null) {
        clearInterval(this.discoveryTimer);
        this.discoveryTimer = null;
      }
      if (this.mqttRecoveryTimer !== null) {
        clearTimeout(this.mqttRecoveryTimer);
        this.mqttRecoveryTimer = null;
      }
      this.mqttClient.disconnect();

      for (const [, controller] of this.accessoryControllers) {
        controller.destroy?.();
      }
      this.accessoryControllers.clear();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverDevices(): Promise<void> {
    if (this.discovering) {
      this.log.debug('Discovery already in progress; skipping overlapping run.');
      return;
    }
    this.discovering = true;

    // Config validation
    if (!this.config['username'] || !this.config['password']) {
      this.log.error('Missing username or password in config. Plugin will not initialize.');
      this.discovering = false;
      return;
    }

    const brand = this.config['brand'] as string | undefined;
    if (brand && brand !== 'phyn' && brand !== 'kohler') {
      this.log.error(`Invalid brand "${brand}" in config. Must be "phyn" or "kohler".`);
      this.discovering = false;
      return;
    }

    try {
      await this.phynApi.authenticate();
    } catch (err) {
      this.log.error(`Authentication failed: ${(err as Error).message}`);
      this.discovering = false;
      return;
    }

    try {
      const homes = await this.phynApi.getHomes();
      const discoveredUUIDs: string[] = [];

      for (const home of homes) {
        const devices = home.devices ?? [];

        for (const device of devices) {
          const uuid = this.api.hap.uuid.generate(device.device_id);
          discoveredUUIDs.push(uuid);

          const existingAccessory = this.accessories.get(uuid);
          let accessory: PlatformAccessory;

          if (existingAccessory) {
            this.log.info(`Restoring existing accessory from cache: ${existingAccessory.displayName}`);
            existingAccessory.context.device = device;
            this.api.updatePlatformAccessories([existingAccessory]);
            accessory = existingAccessory;
          } else {
            this.log.info(`Adding new accessory: ${device.device_id}`);
            accessory = new this.api.platformAccessory(`Phyn ${device.product_code} (${device.device_id})`, uuid);
            accessory.context.device = device;
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.accessories.set(uuid, accessory);
          }

          const deviceType = detectDeviceType(device.product_code);
          const existingController = this.accessoryControllers.get(uuid);
          if (!existingController) {
            switch (deviceType) {
              case 'PP': {
                const controller = new PPAccessory(this, accessory);
                this.accessoryControllers.set(uuid, controller);
                break;
              }
              case 'PC': {
                const controller = new PCAccessory(this, accessory);
                this.accessoryControllers.set(uuid, controller);
                break;
              }
              case 'PW': {
                const controller = new PWAccessory(this, accessory);
                this.accessoryControllers.set(uuid, controller);
                break;
              }
              default:
                this.log.warn(`Unknown device type for product_code: ${device.product_code}`);
            }
          }
        }
      }

      // Unregister stale accessories
      const staleAccessories: PlatformAccessory[] = [];
      for (const [uuid, accessory] of this.accessories) {
        if (!discoveredUUIDs.includes(uuid)) {
          this.accessoryControllers.get(uuid)?.destroy?.();
          this.accessoryControllers.delete(uuid);
          staleAccessories.push(accessory);
          this.accessories.delete(uuid);
        }
      }
      if (staleAccessories.length > 0) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
        this.log.info(`Removed ${staleAccessories.length} stale accessories`);
      }

      // Connect MQTT using IoT policy
      try {
        const userId = this.config['username'] as string;
        const iotPolicy = await this.phynApi.getIotPolicy(userId);
        await this.mqttClient.connect(iotPolicy.wss_url);
        if (!this.mqttRecoveryListenerRegistered) {
          this.mqttClient.on('reconnect_failed', () => {
            this.log.warn(
              `MQTT reconnect exhausted all attempts. Will retry in ${MQTT_RECOVERY_INTERVAL_MS / 1000}s.`,
            );
            // Cancel any already-scheduled recovery to avoid stacking timers
            if (this.mqttRecoveryTimer !== null) {
              clearTimeout(this.mqttRecoveryTimer);
            }
            this.mqttRecoveryTimer = setTimeout(() => {
              this.mqttRecoveryTimer = null;
              this.log.info('Attempting MQTT recovery after reconnect failure...');
              this.mqttClient.reconnectFromScratch();
            }, MQTT_RECOVERY_INTERVAL_MS);
          });
          this.mqttRecoveryListenerRegistered = true;
        }
      } catch (err) {
        this.log.warn(`Failed to connect MQTT (real-time updates disabled): ${(err as Error).message}`);
      }

    } catch (err) {
      this.log.error(`Device discovery failed: ${(err as Error).message}`);
    } finally {
      this.discovering = false;
    }
  }

  private scheduleDailyDiscovery(): void {
    if (this.discoveryTimer !== null) {
      clearInterval(this.discoveryTimer);
    }

    this.discoveryTimer = setInterval(() => {
      this.log.info('Running scheduled daily Phyn discovery refresh');
      this.discoverDevices();
    }, DEVICE_DISCOVERY_INTERVAL_MS);
  }
}
