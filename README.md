# Alapaap

Personal server monitoring and management dashboard.

A standalone Node.js application with a monospace console-style UI for monitoring system resources, managing systemd services, Docker containers, and ClickHouse databases.

## Requirements

- Node.js >= 20
- Linux (reads from `/proc` filesystem)
- Docker (optional, for container management)
- ClickHouse (optional, for database management)

## Quick Start

```bash
cd /var/www/alapaap
npm install
npm start
```

On first run, an admin account is created automatically. The credentials are printed to the console:

```
  ╔══════════════════════════════════════════════╗
  ║  FIRST RUN - Admin account created           ║
  ║  username: admin                             ║
  ║  password: <random>                          ║
  ╚══════════════════════════════════════════════╝
```

Open `http://localhost:3000` and log in. Change the default password immediately via Settings.

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `ALAPAAP_PORT` | `3000` | Server port |
| `ALAPAAP_HOST` | `0.0.0.0` | Bind address |
| `ALAPAAP_DB_PATH` | `data/alapaap.db` | SQLite database path |
| `ALAPAAP_JWT_EXPIRY` | `8h` | JWT token lifetime |
| `CLICKHOUSE_HOST` | `localhost` | ClickHouse host |
| `CLICKHOUSE_PORT` | `8123` | ClickHouse HTTP port |
| `CLICKHOUSE_USER` | `default` | ClickHouse user |
| `CLICKHOUSE_PASSWORD` | (empty) | ClickHouse password |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket path |
| `ALAPAAP_COOKIE_SECURE` | (off) | Set `1` or `true` to send session cookie with `Secure` (use with HTTPS) |
| `ALAPAAP_TRUST_PROXY` | (off) | Set `1` or hop count (e.g. `2`) when behind a reverse proxy so `req.ip` and rate limits use the real client |
| `ALAPAAP_WS_AUTH_TIMEOUT_MS` | `30000` | Close WebSocket if the client does not authenticate within this many milliseconds |

## Modules

| Module | Description |
|---|---|
| `auth` | SQLite-backed user auth with bcrypt + JWT |
| `system-monitor` | CPU, memory, disk, network, processes (real-time via WebSocket) |
| `services-manager` | Systemd service listing, start/stop/restart, log viewing |
| `docker-manager` | Docker container and image management via Engine API |
| `clickhouse-manager` | ClickHouse status, database browser, query editor, metrics |

### Adding a Module

Create a folder in `src/modules/<name>/` with an `index.js` exporting:

```javascript
module.exports = {
  name: 'my-module',
  version: '1.0.0',
  description: 'Description',
  init({ app, wss, config }) { },
  routes: require('./routes'),
  wsChannels: ['my-module:data'],
  destroy() { },
};
```

Add the module name to `config.modules.enabled` and restart.

## Security

- All API routes require JWT authentication
- Passwords hashed with bcrypt (cost 12)
- Shell commands execute through an allowlist-only command guard
- ClickHouse queries are filtered to read-only (SELECT/SHOW/DESCRIBE/EXPLAIN)
- Rate limiting on login (5/min per IP)
- CSRF mitigation: `SameSite=Strict` session cookie plus Origin header validation when the browser sends `Origin`
- Security headers: CSP, X-Frame-Options, X-Content-Type-Options
- All destructive actions logged to audit trail

## Development

```bash
npm run dev    # starts with --watch for auto-reload
```

## License

Private / Unlicensed
