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
  PhynDevice,
  PhynDeviceState,
  PhynConsumption,
  PhynWaterStats,
  PhynFirmware,
  PhynHealthTest,
  PhynIotPolicy,
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.refreshTokenIfNeeded();
    const response = await axios.request<T>({
      method,
      url: `${PHYN_API_BASE}${path}`,
      headers: {
        Authorization: `Bearer ${this.idToken}`,
        'x-api-key': this.apiKey(),
        'Content-Type': 'application/json',
      },
      data: body,
    });
    return response.data;
  }

  async getHomes(): Promise<PhynHome[]> {
    return this.request<PhynHome[]>('GET', '/homeowner/homes');
  }

  async getDevices(homeId: string): Promise<PhynDevice[]> {
    return this.request<PhynDevice[]>('GET', `/homeowner/homes/${homeId}/devices`);
  }

  async getDeviceState(deviceId: string): Promise<PhynDeviceState> {
    return this.request<PhynDeviceState>('GET', `/homeowner/devices/${deviceId}/state`);
  }

  async getConsumptionDetails(deviceId: string): Promise<PhynConsumption> {
    return this.request<PhynConsumption>('GET', `/homeowner/devices/${deviceId}/consumption`);
  }

  async getWaterStatistics(deviceId: string): Promise<PhynWaterStats> {
    return this.request<PhynWaterStats>('GET', `/homeowner/devices/${deviceId}/water-statistics`);
  }

  async getFirmwareInfo(deviceId: string): Promise<PhynFirmware> {
    return this.request<PhynFirmware>('GET', `/homeowner/devices/${deviceId}/firmware`);
  }

  async getHealthTests(deviceId: string): Promise<PhynHealthTest[]> {
    return this.request<PhynHealthTest[]>('GET', `/homeowner/devices/${deviceId}/health-tests`);
  }

  async getIotPolicy(userId: string): Promise<PhynIotPolicy> {
    return this.request<PhynIotPolicy>('GET', `/homeowner/users/${userId}/iot-policy`);
  }

  async openValve(deviceId: string): Promise<void> {
    await this.request<void>('PUT', `/homeowner/devices/${deviceId}/sov`, { state: 'Open' });
  }

  async closeValve(deviceId: string): Promise<void> {
    await this.request<void>('PUT', `/homeowner/devices/${deviceId}/sov`, { state: 'Close' });
  }

  async getLeakSensitivityAwayMode(deviceId: string): Promise<boolean> {
    const result = await this.request<{ away_mode: boolean }>('GET', `/homeowner/devices/${deviceId}/preferences`);
    return result.away_mode;
  }

  async setPreferences(deviceId: string, prefs: Record<string, unknown>): Promise<void> {
    await this.request<void>('PUT', `/homeowner/devices/${deviceId}/preferences`, prefs);
  }

  async getAutoShutoff(deviceId: string): Promise<PhynAutoShutoff> {
    return this.request<PhynAutoShutoff>('GET', `/homeowner/devices/${deviceId}/auto-shutoff`);
  }

  async enableAutoShutoff(deviceId: string): Promise<void> {
    await this.request<void>('PUT', `/homeowner/devices/${deviceId}/auto-shutoff`, { enabled: true });
  }

  async disableAutoShutoff(deviceId: string, time?: number): Promise<void> {
    await this.request<void>('PUT', `/homeowner/devices/${deviceId}/auto-shutoff`, {
      enabled: false,
      ...(time !== undefined ? { time } : {}),
    });
  }
}
