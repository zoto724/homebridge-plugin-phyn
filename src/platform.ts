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
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { detectDeviceType } from './utils.js';

export class PhynPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  public readonly phynApi: PhynApi;
  public readonly mqttClient: MqttClient;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.phynApi = new PhynApi(log, config);
    this.mqttClient = new MqttClient(log);

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverDevices(): Promise<void> {
    // Config validation
    if (!this.config['username'] || !this.config['password']) {
      this.log.error('Missing username or password in config. Plugin will not initialize.');
      return;
    }

    const brand = this.config['brand'] as string | undefined;
    if (brand && brand !== 'phyn' && brand !== 'kohler') {
      this.log.error(`Invalid brand "${brand}" in config. Must be "phyn" or "kohler".`);
      return;
    }

    try {
      await this.phynApi.authenticate();
    } catch (err) {
      this.log.error(`Authentication failed: ${(err as Error).message}`);
      return;
    }

    try {
      const homes = await this.phynApi.getHomes();
      const discoveredUUIDs: string[] = [];

      for (const home of homes) {
        let devices;
        try {
          devices = await this.phynApi.getDevices(home.id);
        } catch (err) {
          this.log.error(`Failed to get devices for home ${home.id}: ${(err as Error).message}`);
          continue;
        }

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
            accessory = new this.api.platformAccessory(device.device_id, uuid);
            accessory.context.device = device;
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.accessories.set(uuid, accessory);
          }

          const deviceType = detectDeviceType(device.product_code);
          switch (deviceType) {
            case 'PP':
              new PPAccessory(this, accessory);
              break;
            case 'PC':
              new PCAccessory(this, accessory);
              break;
            case 'PW':
              new PWAccessory(this, accessory);
              break;
            default:
              this.log.warn(`Unknown device type for product_code: ${device.product_code}`);
          }
        }
      }

      // Unregister stale accessories
      const staleAccessories: PlatformAccessory[] = [];
      for (const [uuid, accessory] of this.accessories) {
        if (!discoveredUUIDs.includes(uuid)) {
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
      } catch (err) {
        this.log.error(`Failed to connect MQTT: ${(err as Error).message}`);
      }

    } catch (err) {
      this.log.error(`Device discovery failed: ${(err as Error).message}`);
    }
  }
}
