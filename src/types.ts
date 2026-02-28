import { PlatformConfig } from 'homebridge';

export interface PhynConfig extends PlatformConfig {
  username: string;
  password: string;
  brand?: 'phyn' | 'kohler';
  pollingInterval?: number;
}

export interface PhynHome {
  id: string;
  name: string;
}

export interface PhynDevice {
  device_id: string;
  product_code: string;
  serial_number: string;
  firmware_version: string;
  online_status: 'online' | 'offline' | string;
}

export interface PhynDeviceState {
  device_id: string;
  sov_status: 'Open' | 'Close';
  flow: { mean: number };
  pressure: { mean: number };
  temperature: { mean: number };
  online_status: string;
  alerts?: {
    water_detected?: boolean;
    is_leak?: boolean;
  };
  away_mode?: boolean;
}

export interface PhynWaterStats {
  temperature: number;
  humidity: number;
  battery_level: number;
}

export interface PhynConsumption {
  daily_gallons: number;
}

export interface PhynAutoShutoff {
  enabled: boolean;
}

export interface PhynHealthTest {
  is_leak: boolean;
  test_time: string;
}

export interface PhynFirmware {
  version: string;
}

export interface PhynIotPolicy {
  wss_url: string;
  user_id: string;
}

export interface PhynMqttPayload {
  device_id?: string;
  sov_status?: 'Open' | 'Close';
  flow?: { mean: number };
  pressure?: { mean: number };
  temperature?: { mean: number };
  alerts?: { water_detected?: boolean; is_leak?: boolean };
}
