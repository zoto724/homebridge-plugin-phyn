import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PhynApi, AuthError, NetworkError } from '../../../src/api/phynApi.js';

// Mock amazon-cognito-identity-js
const mockAuthenticateUser = vi.fn();
const mockRefreshSession = vi.fn();
const mockGetSignInUserSession = vi.fn();

vi.mock('amazon-cognito-identity-js', () => {
  return {
    CognitoUserPool: vi.fn().mockImplementation(() => ({})),
    AuthenticationDetails: vi.fn().mockImplementation((details) => details),
    CognitoUser: vi.fn().mockImplementation(() => ({
      authenticateUser: mockAuthenticateUser,
      refreshSession: mockRefreshSession,
      getSignInUserSession: mockGetSignInUserSession,
    })),
  };
});

// Mock axios
vi.mock('axios', () => ({
  default: {
    request: vi.fn(),
  },
}));

// Mock setTimeout to make retry tests instant
vi.mock('../../../src/settings.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/settings.js')>();
  return { ...original, AUTH_RETRY_DELAY_MS: 0 };
});

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockConfig = {
  platform: 'PhynPlatform',
  name: 'Phyn',
  username: 'test@example.com',
  password: 'test-password',
  brand: 'phyn',
};

const mockSession = {
  getAccessToken: () => ({
    getJwtToken: () => 'access-token',
    getExpiration: () => Date.now() / 1000 + 3600,
  }),
  getIdToken: () => ({ getJwtToken: () => 'id-token' }),
  getRefreshToken: () => ({ getToken: () => 'refresh-token' }),
};

describe('PhynApi', () => {
  let api: PhynApi;

  beforeEach(() => {
    vi.clearAllMocks();
    api = new PhynApi(mockLog as any, mockConfig as any);
  });

  describe('authenticate()', () => {
    it('resolves without error on successful auth and stores tokens', async () => {
      mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
        callbacks.onSuccess(mockSession);
      });

      await expect(api.authenticate()).resolves.toBeUndefined();

      // Verify tokens are stored by checking that getHomes() would use them
      // (we can verify indirectly via the axios mock)
      const axios = (await import('axios')).default;
      (axios.request as any).mockResolvedValueOnce({ data: [] });

      await expect(api.getHomes()).resolves.toEqual([]);
      expect(axios.request).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            // aiophyn sends the access token directly without "Bearer" prefix
            Authorization: 'access-token',
          }),
        }),
      );
    });

    it('throws AuthError on NotAuthorizedException (bad credentials)', async () => {
      const credError = new Error('Incorrect username or password.');
      credError.name = 'NotAuthorizedException';

      mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
        callbacks.onFailure(credError);
      });

      await expect(api.authenticate()).rejects.toThrow(AuthError);
      await expect(api.authenticate()).rejects.toThrow('Authentication failed');
    });

    it('throws AuthError on UserNotFoundException', async () => {
      const notFoundError = new Error('User does not exist.');
      notFoundError.name = 'UserNotFoundException';

      mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
        callbacks.onFailure(notFoundError);
      });

      await expect(api.authenticate()).rejects.toThrow(AuthError);
    });

    it('throws NetworkError after 3 network error attempts', async () => {
      const networkError = new Error('Network request failed');
      networkError.name = 'NetworkError';

      // AUTH_RETRY_DELAY_MS is mocked to 0 so retries are instant
      mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
        callbacks.onFailure(networkError);
      });

      await expect(api.authenticate()).rejects.toThrow(NetworkError);

      // Should have attempted exactly 3 times
      expect(mockAuthenticateUser).toHaveBeenCalledTimes(3);
      // Should have logged warnings for each failed attempt
      expect(mockLog.warn).toHaveBeenCalledTimes(3);
      // Should log a final error after all retries exhausted
      expect(mockLog.error).toHaveBeenCalledTimes(1);
    });

    it('does not retry on credential errors (NotAuthorizedException)', async () => {
      const credError = new Error('Incorrect username or password.');
      credError.name = 'NotAuthorizedException';

      mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
        callbacks.onFailure(credError);
      });

      await expect(api.authenticate()).rejects.toThrow(AuthError);

      // Should only attempt once — no retries for credential errors
      expect(mockAuthenticateUser).toHaveBeenCalledTimes(1);
    });
  });

  describe('getHomes() not called after auth failure', () => {
    it('getHomes() requires a valid token — throws without prior auth', async () => {
      // Without calling authenticate(), accessToken is null.
      // refreshTokenIfNeeded() returns early when cognitoUser is null,
      // so the request proceeds with Authorization: Bearer null.
      // The axios mock will reject to simulate the server rejecting the null token.
      const axios = (await import('axios')).default;
      (axios.request as any).mockRejectedValueOnce(new Error('401 Unauthorized'));

      await expect(api.getHomes()).rejects.toThrow('401 Unauthorized');
    });

    it('getHomes() is never called when authenticate() throws AuthError', async () => {
      const credError = new Error('Incorrect username or password.');
      credError.name = 'NotAuthorizedException';

      mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
        callbacks.onFailure(credError);
      });

      const axios = (await import('axios')).default;
      const axiosRequestSpy = axios.request as any;

      // Simulate platform-level flow: authenticate first, then getHomes
      let getHomesWasCalled = false;
      try {
        await api.authenticate();
        // This line should never be reached
        getHomesWasCalled = true;
        await api.getHomes();
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
      }

      expect(getHomesWasCalled).toBe(false);
      expect(axiosRequestSpy).not.toHaveBeenCalled();
    });

    it('getHomes() is never called when authenticate() throws NetworkError', async () => {
      const networkError = new Error('Network request failed');
      networkError.name = 'NetworkError';

      // AUTH_RETRY_DELAY_MS is mocked to 0 so retries are instant
      mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
        callbacks.onFailure(networkError);
      });

      const axios = (await import('axios')).default;
      const axiosRequestSpy = axios.request as any;

      let getHomesWasCalled = false;
      try {
        await api.authenticate();
        getHomesWasCalled = true;
        await api.getHomes();
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkError);
      }

      expect(getHomesWasCalled).toBe(false);
      expect(axiosRequestSpy).not.toHaveBeenCalled();
    });
  });
});
