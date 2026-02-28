import { PlatformConfig } from 'homebridge';

export interface PhynConfig extends PlatformConfig {
  username: string;
  password: string;
  brand?: 'phyn' | 'kohler';
  pollingInterval?: number;
}

export interface PhynDevice {
  device_id: string;
  product_code: string;
  serial_number: string;
  fw_version: string;
  online_status: { v: string };
}

export interface PhynHome {
  id: string;
  name: string;
  devices: PhynDevice[];
}

// Device state fields use {v, ts} or {mean} shapes
export interface PhynValueField {
  v?: number;
  mean?: number;
  ts?: number;
}

export interface PhynDeviceState {
  device_id?: string;
  sov_status: { v: string };
  flow?: PhynValueField;
  pressure?: PhynValueField;
  temperature?: PhynValueField;
  online_status?: { v: string };
  fw_version?: string;
  serial_number?: string;
  product_code?: string;
  // Phyn Classic dual-line fields
  pressure1?: PhynValueField;
  pressure2?: PhynValueField;
  temperature1?: PhynValueField;
  temperature2?: PhynValueField;
  alerts?: {
    is_leak?: boolean;
  };
}

export interface PhynWaterStats {
  ts?: number;
  temperature?: Array<{ value: number }>;
  humidity?: Array<{ value: number }>;
  battery_level?: number;
  alerts?: {
    water_detected?: boolean;
    high_humidity?: boolean;
    low_humidity?: boolean;
    low_temperature?: boolean;
    water?: boolean;
  };
}

export interface PhynConsumption {
  water_consumption?: number;
}

export interface PhynAutoShutoff {
  auto_shutoff_enable: boolean;
}

export interface PhynHealthTest {
  data: Array<{
    end_time: number;
    is_leak: boolean;
    is_warn: boolean;
  }>;
}

export interface PhynFirmware {
  fw_version: string;
  fw_img_name?: string;
  product_code?: string;
  release_notes?: string;
}

export interface PhynMqttPayload {
  device_id?: string;
  sov_state?: string;
  flow?: PhynValueField;
  sensor_data?: {
    pressure?: PhynValueField;
    temperature?: PhynValueField;
  };
  consumption?: { v: number };
  flow_state?: { v: string };
}
