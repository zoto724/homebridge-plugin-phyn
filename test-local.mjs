/**
 * Local integration test for the Phyn API.
 * Tests auth and all major endpoints against the real API.
 *
 * Usage:
 *   PHYN_USER=you@email.com PHYN_PASS=yourpassword node test-local.mjs
 *
 * Optional: set DEVICE_ID to skip auto-discovery and test device endpoints directly.
 *   PHYN_USER=... PHYN_PASS=... DEVICE_ID=abc123 node test-local.mjs
 */

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from 'amazon-cognito-identity-js';
import axios from 'axios';

const COGNITO_POOL_ID = 'us-east-1_UAv6IUsyh';
const COGNITO_CLIENT_ID = '5q2m8ti0urmepg4lup8q0ptldq';
const API_KEY = 'E7nfOgW6VI64fYpifiZSr6Me5w1Upe155zbu4lq8';
const API_BASE = 'https://api.phyn.com';

// NOTE: USERNAME is a reserved macOS env var (your system login), so we use PHYN_USER/PHYN_PASS
const username = process.env.PHYN_USER;
const password = process.env.PHYN_PASS;
const envDeviceId = process.env.DEVICE_ID;

if (!username || !password) {
  console.error('Usage: PHYN_USER=you@email.com PHYN_PASS=yourpassword node test-local.mjs');
  process.exit(1);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

console.log(`\nUsername: "${username}"`);
console.log(`Authenticating as ${username}...`);

const userPool = new CognitoUserPool({ UserPoolId: COGNITO_POOL_ID, ClientId: COGNITO_CLIENT_ID });
const cognitoUser = new CognitoUser({ Username: username, Pool: userPool });
const authDetails = new AuthenticationDetails({ Username: username, Password: password });

const session = await new Promise((resolve, reject) => {
  cognitoUser.authenticateUser(authDetails, { onSuccess: resolve, onFailure: reject });
});

const accessToken = session.getAccessToken().getJwtToken();
const idToken = session.getIdToken().getJwtToken();
const expiration = session.getAccessToken().getExpiration();

console.log('✓ Auth OK');
console.log(`  Access token expires: ${new Date(expiration * 1000).toISOString()}`);
console.log(`  Access token (first 40): ${accessToken.slice(0, 40)}...`);
console.log(`  ID token     (first 40): ${idToken.slice(0, 40)}...`);

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// aiophyn sends the token WITHOUT "Bearer " prefix, using the access token
// Our current plugin sends "Bearer <idToken>" — this test checks both variants
async function req(method, path, token, label, params) {
  const url = `${API_BASE}${path}`;
  const headers = {
    Authorization: token,          // no "Bearer" prefix — matches aiophyn
    'x-api-key': API_KEY,
    'Content-Type': 'application/json',
    'User-Agent': 'phyn/18 CFNetwork/1331.0.7 Darwin/21.4.0',
    Accept: 'application/json',
  };
  try {
    const res = await axios({ method, url, headers, params });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return { ok: false, status: err.response?.status, data: err.response?.data, error: err.message };
  }
}

function pass(label, status) { console.log(`  ✓ ${label} → ${status}`); }
function fail(label, status, data) { console.log(`  ✗ ${label} → ${status}`, JSON.stringify(data ?? '').slice(0, 200)); }

async function test(label, method, path, token, params) {
  const r = await req(method, path, token, label, params);
  if (r.ok) {
    pass(label, r.status);
  } else {
    fail(label, r.status, r.data);
  }
  return r;
}

// ── Token comparison ──────────────────────────────────────────────────────────

console.log('\n── Token comparison: /homes ─────────────────────────────────────────────────');
console.log('Testing which token + format works for GET /homes...\n');

const variants = [
  ['access token (no Bearer)',  accessToken],
  ['access token (Bearer)',     `Bearer ${accessToken}`],
  ['id token (no Bearer)',      idToken],
  ['id token (Bearer)',         `Bearer ${idToken}`],
];

let workingToken = null;
let workingTokenLabel = null;

for (const [label, token] of variants) {
  const r = await req('GET', '/homes', token, label, { user_id: username });
  if (r.ok) {
    console.log(`  ✓ ${label} → ${r.status} (WORKS)`);
    if (!workingToken) { workingToken = token; workingTokenLabel = label; }
  } else {
    console.log(`  ✗ ${label} → ${r.status}`);
  }
}

if (!workingToken) {
  console.error('\n✗ No token variant worked for /homes. Check credentials or API key.');
  process.exit(1);
}

console.log(`\n→ Using: ${workingTokenLabel}`);

// ── Homes & device discovery ──────────────────────────────────────────────────

console.log('\n── Discovery ────────────────────────────────────────────────────────────────');
const homesResult = await req('GET', '/homes', workingToken, 'GET /homes', { user_id: username });
const homes = homesResult.data ?? [];
console.log(`  Found ${homes.length} home(s)`);

let deviceId = envDeviceId;
let homeId = null;

for (const home of homes) {
  console.log(`  Home: ${home.name} (${home.id}) — ${home.devices?.length ?? 0} device(s)`);
  for (const device of home.devices ?? []) {
    console.log(`    Device: ${device.device_id} product=${device.product_code} fw=${device.fw_version} online=${device.online_status?.v}`);
    if (!deviceId) {
      deviceId = device.device_id;
      homeId = home.id;
    }
  }
}

if (!deviceId) {
  console.log('\nNo devices found — skipping device endpoint tests.');
  process.exit(0);
}

console.log(`\n→ Testing device endpoints with device_id: ${deviceId}`);

// ── Device endpoints ──────────────────────────────────────────────────────────

console.log('\n── Device endpoints ─────────────────────────────────────────────────────────');

await test('GET /devices/:id/state',              'GET',  `/devices/${deviceId}/state`,              workingToken);
await test('GET /devices/:id/auto_shutoff',       'GET',  `/devices/${deviceId}/auto_shutoff`,       workingToken);
await test('GET /preferences/device/:id',         'GET',  `/preferences/device/${deviceId}`,         workingToken);

const today = new Date();
const duration = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
await test('GET /devices/:id/consumption/details','GET',  `/devices/${deviceId}/consumption/details`, workingToken, {
  device_id: deviceId, duration, precision: 6,
});

await test('GET /devices/:id/health_tests',       'GET',  `/devices/${deviceId}/health_tests`,       workingToken, { list_type: 'grouped' });
await test('GET /firmware/latestVersion/v2',      'GET',  `/firmware/latestVersion/v2`,              workingToken, { device_id: deviceId });

const now = Date.now();
await test('GET /devices/:id/water_statistics',   'GET',  `/devices/${deviceId}/water_statistics/history/`, workingToken, {
  from_ts: now - 86400000,
  to_ts: now,
});

// IoT policy (needed for MQTT) — requires id token, not access token
const encodedUser = encodeURIComponent(username);
await test('POST /users/:id/iot_policy (id token)', 'POST', `/users/${encodedUser}/iot_policy`, idToken);

console.log('\nDone.\n');
