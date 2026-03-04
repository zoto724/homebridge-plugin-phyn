/**
 * Connectivity fix tests for PhynApi
 *
 * Covers:
 *  - #2  Token refresh failure → falls back to full re-authentication
 *  - #3  HTTP request timeout is set
 *  - #8  Null auth header guard — throws AuthError before request
 *  - #13 Auth retry uses exponential backoff with jitter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhynApi, AuthError } from '../../../src/api/phynApi.js';
import { authRetryDelay } from '../../../src/utils.js';
import { API_REQUEST_TIMEOUT_MS } from '../../../src/settings.js';

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

// Mock AUTH_RETRY_DELAY_MS to 0 for fast tests
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

const expiredSession = {
  getAccessToken: () => ({
    getJwtToken: () => 'expired-access-token',
    getExpiration: () => Date.now() / 1000 - 100, // already expired
  }),
  getIdToken: () => ({ getJwtToken: () => 'expired-id-token' }),
  getRefreshToken: () => ({ getToken: () => 'expired-refresh-token' }),
};

describe('Fix #2 — Token refresh failure recovery', () => {
  let api: PhynApi;

  beforeEach(() => {
    vi.clearAllMocks();
    api = new PhynApi(mockLog as any, mockConfig as any);
  });

  it('falls back to full re-authentication when refreshSession fails', async () => {
    // First authenticate successfully with an about-to-expire session
    mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
      callbacks.onSuccess(expiredSession);
    });
    await api.authenticate();

    // Set up the refresh to fail
    mockGetSignInUserSession.mockReturnValue(expiredSession);
    mockRefreshSession.mockImplementation((_token: unknown, cb: any) => {
      cb(new Error('Refresh token revoked'), null);
    });

    // Set up the re-auth to succeed with a fresh session
    mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
      callbacks.onSuccess(mockSession);
    });

    // refreshTokenIfNeeded should fall back to authenticate()
    await expect(api.refreshTokenIfNeeded()).resolves.toBeUndefined();

    // authenticate() should have been called a second time (the re-auth)
    expect(mockAuthenticateUser).toHaveBeenCalledTimes(2);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Token refresh failed, attempting full re-authentication'),
    );
  });

  it('falls back to re-auth when session is null (no active session)', async () => {
    mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
      callbacks.onSuccess(expiredSession);
    });
    await api.authenticate();

    // No session available
    mockGetSignInUserSession.mockReturnValue(null);

    // Re-auth succeeds
    mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
      callbacks.onSuccess(mockSession);
    });

    await expect(api.refreshTokenIfNeeded()).resolves.toBeUndefined();
    expect(mockAuthenticateUser).toHaveBeenCalledTimes(2);
  });
});

describe('Fix #3 — HTTP request timeout', () => {
  let api: PhynApi;

  beforeEach(async () => {
    vi.clearAllMocks();
    api = new PhynApi(mockLog as any, mockConfig as any);

    // Authenticate first
    mockAuthenticateUser.mockImplementation((_details: unknown, callbacks: any) => {
      callbacks.onSuccess(mockSession);
    });
    await api.authenticate();
  });

  it('passes timeout option to axios request', async () => {
    const axios = (await import('axios')).default;
    (axios.request as any).mockResolvedValueOnce({ data: [] });

    await api.getHomes();

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: API_REQUEST_TIMEOUT_MS,
      }),
    );
  });

  it('timeout value is 30000ms', () => {
    expect(API_REQUEST_TIMEOUT_MS).toBe(30000);
  });
});

describe('Fix #8 — Null auth header guard', () => {
  let api: PhynApi;

  beforeEach(() => {
    vi.clearAllMocks();
    api = new PhynApi(mockLog as any, mockConfig as any);
  });

  it('throws AuthError when calling API methods without authenticating', async () => {
    await expect(api.getHomes()).rejects.toThrow(AuthError);
    await expect(api.getHomes()).rejects.toThrow('No valid authentication token available');
  });

  it('does not send an HTTP request when token is null', async () => {
    const axios = (await import('axios')).default;

    try {
      await api.getHomes();
    } catch { /* expected */ }

    expect(axios.request).not.toHaveBeenCalled();
  });
});

describe('Fix #13 — Auth retry backoff with jitter', () => {
  it('authRetryDelay returns a value >= base * 2^attempt', () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const delay = authRetryDelay(attempt, 1000);
      const minExpected = 1000 * Math.pow(2, attempt);
      expect(delay).toBeGreaterThanOrEqual(minExpected);
    }
  });

  it('authRetryDelay returns a value < base * 2^attempt + base (jitter bounded by base)', () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const delay = authRetryDelay(attempt, 1000);
      const maxExpected = 1000 * Math.pow(2, attempt) + 1000;
      expect(delay).toBeLessThan(maxExpected);
    }
  });

  it('authRetryDelay with attempt=0 returns between base and 2*base', () => {
    for (let i = 0; i < 10; i++) {
      const delay = authRetryDelay(0, 5000);
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThan(10000);
    }
  });

  it('successive attempts produce increasing delays', () => {
    // With high probability, attempt 3 delay > attempt 0 delay
    const delays = Array.from({ length: 4 }, (_, i) => authRetryDelay(i, 1000));
    // The exponential part doubles each time, so even with jitter,
    // attempt 2 (base=4000) should be > attempt 0 (base=1000) almost always
    expect(delays[2]).toBeGreaterThan(delays[0]);
  });
});
