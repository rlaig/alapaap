# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-04-07

### Added

- **ClickHouse storage & retention** (clickhouse-manager): `GET /api/clickhouse-manager/storage/overview` — table sizes, engines, partition keys from `system.tables`
- Retention metadata `GET /api/clickhouse-manager/storage/:db/:table` — suggested Date/DateTime columns, TTL snippet, MergeTree / Distributed hints
- `POST /api/clickhouse-manager/storage/preview` — row count for `ALTER DELETE` (time column + days) and eligible partitions via `system.parts` (`max_date` vs `subtractDays`)
- `POST /api/clickhouse-manager/storage/execute` — guarded `DROP PARTITION` (only ids from current preview window) or `ALTER DELETE` with `maxAlterDeleteRows` cap; requires confirm string `DELETE OLD DATA`
- `clickhouse.execMutation` for server-built DDL only (not user SQL)
- Config `clickhouse.retention`: deny list, optional `ALAPAAP_CH_RETENTION_ALLOWED_DBS`, `ALAPAAP_CH_MAX_ALTER_DELETE_ROWS`, `ALAPAAP_CH_MAX_DROP_PARTITIONS`, `ALAPAAP_CH_MUTATION_TIMEOUT_MS`
- ClickHouse UI panel **storage & retention**: table picker, preview, partition checkboxes, destructive actions behind confirmation phrase
- Audit log actions `clickhouse_retention_preview` and `clickhouse_retention_execute`

### Changed

- `dev.env` documents optional ClickHouse retention environment variables

## [1.1.0] - 2026-03-24

### Added

- `network-check` module: network interface overview, local TCP listeners from `/proc/net/tcp*`, well-known port labels
- Remote TCP port check (single host/port) and batch port scan with SSRF-oriented allowlisting; optional `ALAPAAP_NETWORK_ALLOW_PUBLIC=1`
- Sidebar **network** page and REST API under `/api/network-check`
- Audit log actions `network_tcp_check` and `network_port_scan`

### Changed

- `dev.env` documents `ALAPAAP_NETWORK_ALLOW_PUBLIC` and references `networkCheck` timeout/batch defaults in `config/default.js`

## [1.0.0] - 2026-03-23

### Added

- Rate limiting on login endpoint (5 attempts/min per IP)
- CSRF protection via Origin header validation
- Security headers: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy
- Request logging for API endpoints
- Audit log viewer in settings page
- README with setup, configuration, and security documentation

### Changed

- Error handler now sanitizes 500 errors (no stack traces exposed)

## [0.6.0] - 2026-03-23

### Added

- ClickHouse manager module
- ClickHouse status monitoring and ping
- Database and table browser with tree-style navigation
- SQL query editor with Ctrl+Enter execution
- Query result display as fixed-width console table
- SQL validation: only SELECT/SHOW/DESCRIBE/EXPLAIN allowed
- Dangerous keyword blocking (DROP, TRUNCATE, ALTER, etc.)
- Auto-injected LIMIT on unbounded queries
- ClickHouse metrics via WebSocket push (queries, connections, merges)
- Recent query log viewer

## [0.5.0] - 2026-03-23

### Added

- Docker manager module
- Container listing mimicking `docker ps` output format
- Container start/stop/restart/remove with confirmation dialogs
- Container log viewer
- Docker image listing
- Container ID/name validation
- Docker status via WebSocket push every 5s

## [0.4.0] - 2026-03-23

### Added

- Services manager module
- Systemd service listing, status, start/stop/restart
- Service log viewer via journalctl
- Service name validation (`^[a-zA-Z0-9_@:.-]+$`)
- Hardened systemctl wrapper: only allowed subcommands (list-units, show, start, stop, restart, status)
- All service actions audit-logged
- Services status via WebSocket push every 5s

## [0.3.0] - 2026-03-23

### Added

- System monitor module
- CPU usage from /proc/stat differentials
- Memory stats from /proc/meminfo
- Disk usage via allowlisted `df` command
- Network I/O from /proc/net/dev
- Process list from /proc/<pid>/stat (top 15 by CPU)
- Load average and uptime
- Real-time metrics push via WebSocket every 2s
- Dashboard overview with ASCII text gauges
- System monitor detail view with process table

## [0.2.0] - 2026-03-23

### Added

- SQLite database with migration system
- User model with bcrypt password hashing (cost 12)
- JWT authentication with configurable expiry
- Auth middleware for HTTP routes and WebSocket connections
- Login/logout/change-password API endpoints
- First-run admin account auto-creation with random password
- Console-style login page with ASCII art header
- Settings page with password change form
- Audit log table for security events

## [0.1.0] - 2026-03-23

### Added

- Project scaffold with Express 5 + WebSocket server
- Module loader: auto-discovers modules, mounts routes, registers WS channels
- WebSocket infrastructure with channel subscription model and broadcast
- Command guard: allowlist-based shell command executor with argument sanitization
- Audit log framework
- Mobile-first monospace console-style SPA shell
- Hash-based client-side routing
- WebSocket client with auto-reconnect and exponential backoff
- API fetch wrapper with JWT injection
- Dark theme with CSS custom properties
