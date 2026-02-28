import axios from 'axios';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import type { Logging, PlatformConfig } from 'homebridge';
import {
  PHYN_API_BASE,
  COGNITO_POOL_ID,
  COGNITO_CLIENT_ID,
  API_KEY_PHYN,
  API_KEY_KOHLER,
  AUTH_RETRY_ATTEMPTS,
  AUTH_RETRY_DELAY_MS,
  TOKEN_REFRESH_BUFFER_SECS,
} from '../settings.js';
import type {
  PhynHome,
  PhynDeviceState,
  PhynConsumption,
  PhynWaterStats,
  PhynFirmware,
  PhynHealthTest,
  PhynAutoShutoff,
} from '../types.js';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class PhynApi {
  private accessToken: string | null = null;
  private idToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private cognitoUser: CognitoUser | null = null;

  constructor(
    private readonly log: Logging,
    private readonly config: PlatformConfig,
  ) {}

  async authenticate(): Promise<void> {
    const userPool = new CognitoUserPool({
      UserPoolId: COGNITO_POOL_ID,
      ClientId: COGNITO_CLIENT_ID,
    });

    const authDetails = new AuthenticationDetails({
      Username: this.config['username'] as string,
      Password: this.config['password'] as string,
    });

    this.cognitoUser = new CognitoUser({
      Username: this.config['username'] as string,
      Pool: userPool,
    });

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < AUTH_RETRY_ATTEMPTS; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.cognitoUser!.authenticateUser(authDetails, {
            onSuccess: (session: CognitoUserSession) => {
              this.accessToken = session.getAccessToken().getJwtToken();
              this.idToken = session.getIdToken().getJwtToken();
              this.tokenExpiresAt = session.getAccessToken().getExpiration();
              resolve();
            },
            onFailure: (err: Error) => {
              reject(err);
            },
          });
        });
        return; // success
      } catch (err) {
        const error = err as Error;
        if (error.name === 'NotAuthorizedException' || error.name === 'UserNotFoundException') {
          throw new AuthError(`Authentication failed: ${error.message}`);
        }
        lastError = new NetworkError(`Network error during authentication: ${error.message}`);
        this.log.warn(`Authentication attempt ${attempt + 1} failed: ${error.message}`);
        if (attempt < AUTH_RETRY_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_DELAY_MS));
        }
      }
    }
    this.log.error(`Authentication failed after ${AUTH_RETRY_ATTEMPTS} attempts`);
    throw lastError ?? new NetworkError('Authentication failed');
  }

  async refreshTokenIfNeeded(): Promise<void> {
    if (!this.cognitoUser || !this.accessToken) return;
    const remaining = this.tokenExpiresAt - Date.now() / 1000;
    if (remaining >= TOKEN_REFRESH_BUFFER_SECS) return;

    await new Promise<void>((resolve, reject) => {
      const session = this.cognitoUser!.getSignInUserSession();
      if (!session) {
        reject(new AuthError('No active session to refresh'));
        return;
      }
      this.cognitoUser!.refreshSession(session.getRefreshToken(), (err, newSession: CognitoUserSession) => {
        if (err) {
          reject(new AuthError(`Token refresh failed: ${err.message}`));
          return;
        }
        this.accessToken = newSession.getAccessToken().getJwtToken();
        this.idToken = newSession.getIdToken().getJwtToken();
        this.tokenExpiresAt = newSession.getAccessToken().getExpiration();
        resolve();
      });
    });
  }

  private apiKey(): string {
    return this.config['brand'] === 'kohler' ? API_KEY_KOHLER : API_KEY_PHYN;
  }

  private async request<T>(method: string, path: string, body?: unknown, params?: Record<string, unknown>, useIdToken = false): Promise<T> {
    await this.refreshTokenIfNeeded();
    const response = await axios.request<T>({
      method,
      url: `${PHYN_API_BASE}${path}`,
      headers: {
        // aiophyn sends the token directly without "Bearer" prefix
        // most endpoints use the access token; iot_policy requires the id token
        Authorization: useIdToken ? this.idToken : this.accessToken,
        'x-api-key': this.apiKey(),
        'Content-Type': 'application/json',
        'User-Agent': 'phyn/18 CFNetwork/1331.0.7 Darwin/21.4.0',
        Accept: 'application/json',
      },
      data: body,
      params,
    });
    return response.data;
  }

  // Returns homes with embedded devices array
  async getHomes(): Promise<PhynHome[]> {
    const username = this.config['username'] as string;
    return this.request<PhynHome[]>('GET', '/homes', undefined, { user_id: username });
  }

  async getDeviceState(deviceId: string): Promise<PhynDeviceState> {
    return this.request<PhynDeviceState>('GET', `/devices/${deviceId}/state`);
  }

  async getConsumptionDetails(deviceId: string, duration: string): Promise<PhynConsumption> {
    return this.request<PhynConsumption>('GET', `/devices/${deviceId}/consumption/details`, undefined, {
      device_id: deviceId,
      duration,
      precision: 6,
    });
  }

  async getWaterStatistics(deviceId: string, fromTs: number, toTs: number): Promise<PhynWaterStats[]> {
    return this.request<PhynWaterStats[]>('GET', `/devices/${deviceId}/water_statistics/history/`, undefined, {
      from_ts: fromTs,
      to_ts: toTs,
    });
  }

  async getFirmwareInfo(deviceId: string): Promise<PhynFirmware> {
    // Returns an array; take the first element
    const result = await this.request<PhynFirmware[]>('GET', `/firmware/latestVersion/v2`, undefined, {
      device_id: deviceId,
    });
    return result[0];
  }

  async getHealthTests(deviceId: string): Promise<PhynHealthTest> {
    return this.request<PhynHealthTest>('GET', `/devices/${deviceId}/health_tests`, undefined, {
      list_type: 'grouped',
    });
  }

  async openValve(deviceId: string): Promise<void> {
    await this.request<void>('POST', `/devices/${deviceId}/sov/Open`);
  }

  async closeValve(deviceId: string): Promise<void> {
    await this.request<void>('POST', `/devices/${deviceId}/sov/Close`);
  }

  async getDevicePreferences(deviceId: string): Promise<PhynPreference[]> {
    return this.request<PhynPreference[]>('GET', `/preferences/device/${deviceId}`);
  }

  async setDevicePreferences(deviceId: string, prefs: PhynPreference[]): Promise<void> {
    await this.request<void>('POST', `/preferences/device/${deviceId}`, prefs);
  }

  async getAutoShutoff(deviceId: string): Promise<PhynAutoShutoff> {
    return this.request<PhynAutoShutoff>('GET', `/devices/${deviceId}/auto_shutoff`);
  }

  async setAutoShutoffEnabled(deviceId: string, enabled: boolean, time?: number): Promise<void> {
    let path = `/devices/${deviceId}/auto_shutoff/status/${enabled ? 'Enable' : 'Disable'}`;
    if (!enabled && time !== undefined) {
      path += `/${time}`;
    }
    await this.request<void>('POST', path);
  }

  async getIotPolicy(userId: string): Promise<{ wss_url: string }> {
    const encodedUserId = encodeURIComponent(userId);
    // aiophyn explicitly uses the id token for this endpoint
    return this.request<{ wss_url: string }>('POST', `/users/${encodedUserId}/iot_policy`, undefined, undefined, true);
  }
}

export interface PhynPreference {
  device_id: string;
  name: string;
  value: string;
}
