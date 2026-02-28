# homebridge-phyn

!! NOT YET WORKING !!

A [Homebridge](https://homebridge.io) plugin for [Phyn](https://www.phyn.com) water monitoring devices, including Kohler-branded variants.

## Supported Devices

| Product Code Prefix | Device | HomeKit Services |
|---|---|---|
| `PP` | Phyn Plus (smart water shutoff) | Valve, Leak Sensor, Temperature Sensor, Away Mode switch, Auto Shutoff switch |
| `PC` | Phyn Plus Clamp | Hot Water Temperature Sensor, Cold Water Temperature Sensor |
| `PW` | Phyn Water Sensor | Leak Sensor, Temperature Sensor, Humidity Sensor, Battery |

## Installation

This package is not yet published to npm. To install locally, clone the repo and run:

```bash
npm install -g .
```

## Configuration

Add the platform to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "PhynPlatform",
      "name": "Phyn",
      "username": "your@email.com",
      "password": "your-password",
      "brand": "phyn",
      "pollingInterval": 60
    }
  ]
}
```

### Config Options

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `username` | string | yes | — | Your Phyn account email |
| `password` | string | yes | — | Your Phyn account password |
| `brand` | `"phyn"` \| `"kohler"` | no | `"phyn"` | Device brand |
| `pollingInterval` | integer (≥10) | no | `60` | API poll interval in seconds |

## How It Works

- Authenticates with the Phyn cloud API via AWS Cognito
- Discovers all homes and devices associated with your account
- Registers each device as a HomeKit accessory based on its product code
- Polls the API on the configured interval to keep characteristics up to date
- Subscribes to real-time MQTT updates over WebSocket for immediate state changes (PP devices)
- Automatically reconnects MQTT with exponential backoff on disconnect
- Refreshes auth tokens before they expire

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

Tests use [Vitest](https://vitest.dev) with [fast-check](https://fast-check.dev) for property-based testing. There are 133 tests across unit and property test suites covering all three accessory types, the platform, the API client, and the MQTT client.

## Attribution

This plugin was AI-generated, inspired by [helicopterrun/phyn](https://github.com/helicopterrun/phyn). That project provided the foundation for understanding the Phyn API and device model.

## License

[MIT](LICENSE)
