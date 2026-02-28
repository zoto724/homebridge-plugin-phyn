// Quick standalone API test - run with: node test-api.mjs
// Usage: USERNAME=you@email.com PASSWORD=yourpassword node test-api.mjs

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

const username = process.env.USERNAME;
const password = process.env.PASSWORD;

if (!username || !password) {
  console.error('Set USERNAME and PASSWORD env vars');
  process.exit(1);
}

console.log(`Authenticating as ${username}...`);

const userPool = new CognitoUserPool({ UserPoolId: COGNITO_POOL_ID, ClientId: COGNITO_CLIENT_ID });
const cognitoUser = new CognitoUser({ Username: username, Pool: userPool });
const authDetails = new AuthenticationDetails({ Username: username, Password: password });

const session = await new Promise((resolve, reject) => {
  cognitoUser.authenticateUser(authDetails, {
    onSuccess: resolve,
    onFailure: reject,
  });
});

const accessToken = session.getAccessToken().getJwtToken();
const idToken = session.getIdToken().getJwtToken();
console.log('Auth OK');
console.log('  Access token (first 40):', accessToken.slice(0, 40));
console.log('  ID token (first 40):    ', idToken.slice(0, 40));

async function get(path, token, label) {
  console.log(`\nGET ${path} [${label}]`);
  try {
    const res = await axios.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-api-key': API_KEY },
    });
    console.log('  Status:', res.status);
    console.log('  Body:', JSON.stringify(res.data, null, 2).slice(0, 500));
  } catch (err) {
    console.log('  Status:', err.response?.status);
    console.log('  Body:', JSON.stringify(err.response?.data));
  }
}

// Try both tokens so we can see which one works
await get('/homeowner/homes', accessToken, 'access token');
await get('/homeowner/homes', idToken, 'id token');
