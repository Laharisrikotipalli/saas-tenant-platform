# Multi-Tenant SaaS Platform

A production-ready multi-tenant SaaS backend demonstrating containerization, connection pooling, JWT authentication, RBAC, tenant isolation, atomic transactions, rate limiting, structured logging, and ≥70% test coverage — all started with a single command.

## Quick Start

```bash
cp .env.example .env
docker compose up --build
```

All four services start automatically with health checks. The app waits for `db`, `pgbouncer`, and `cache` to be healthy before starting. Seed data loads automatically from `seeds/01_init.sql`.

## Architecture

```
Client (HTTP :4000)
        │
        ▼
┌──────────────────────────────────────┐  docker-compose network
│         Node.js App (Express)        │──────────────► Redis 7
│  Auth · Tenants · Projects · Health  │               (cache, :6379)
│  JWT · RBAC · Rate limit · Swagger   │
└──────────────────────────────────────┘
        │
        ▼ SQL
┌─────────────────┐
│   pgBouncer     │  transaction pool mode (:5432)
└─────────────────┘
        │
        ▼ pool
┌─────────────────────────────────────────────────┐
│               PostgreSQL 15                     │
│  tenants · users · user_roles · projects        │
│  project_users  (auto-seeded on first boot)     │
└─────────────────────────────────────────────────┘
```

The app never connects directly to Postgres — every query goes through pgBouncer in **transaction pool mode**, which recycles server connections between requests for efficiency.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 + Express |
| Database | PostgreSQL 15 |
| Connection pool | pgBouncer (transaction mode) |
| Cache | Redis 7 |
| Auth | JWT (access 15m, refresh 7d) + Google OAuth 2.0 mock |
| Docs | Swagger UI at `/api-docs` |
| Logging | Winston — structured JSON with correlation IDs |
| Tests | Jest + Supertest — 30 tests, 88% coverage |

## Environment Variables

Copy `.env.example` to `.env`. No real secrets needed — Google OAuth is mocked, JWT secret is pre-set.

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (points to pgBouncer) |
| `REDIS_URL` | Redis connection string |
| `PORT` | App server port (default 3000) |
| `JWT_SECRET` | Secret for signing JWTs |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (placeholder) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret (placeholder) |

## API Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | Public | Service health — returns db + cache status |
| GET | `/api/health/db-pool` | Public | pgBouncer pool stats |
| POST | `/api/tenants` | Public | Create a new tenant (201) |
| DELETE | `/api/tenants/:tenantId/users/:userId` | Admin JWT | Remove user — admin role only (204/403) |
| GET | `/api/auth/google/callback` | Public | OAuth callback — returns accessToken + refreshToken |
| POST | `/api/auth/login` | Public | Login by email — rate limited 10 req/min |
| GET | `/api/me` | JWT | Current user — id, email, tenantId, role |
| GET | `/api/projects/:projectId` | JWT | Fetch project — tenant-isolated (404 if wrong tenant) |
| POST | `/api/projects/complex-create` | JWT | Atomic project creation with rollback demo |
| GET | `/api-docs` | Public | Swagger UI (OpenAPI 3.0) |

## Database Schema

```sql
tenants       (id UUID PK, name VARCHAR UNIQUE, created_at)
users         (id UUID PK, email VARCHAR UNIQUE, tenant_id FK → tenants)
user_roles    (user_id UUID PK FK → users, role CHECK IN ('admin','member'))
projects      (id UUID PK, name VARCHAR, tenant_id FK → tenants)
project_users (project_id FK, user_id FK, PRIMARY KEY (project_id, user_id))
```

Tenant isolation is enforced by scoping every protected query to `req.user.tenantId` from the JWT.

## Seeded Test Data

| Entity | Email / Name | Role | Tenant |
|---|---|---|---|
| Admin user | admin@tenanta.com | admin | TenantA |
| Member user | member@tenanta.com | member | TenantA |
| User B | user@tenantb.com | member | TenantB |
| OAuth test user | test@default.com | admin | DefaultTenant |
| Project Alpha | — | — | TenantA |
| Project Beta | — | — | TenantB |

## Testing

```bash
# Inside Docker
docker compose exec app npm run test:coverage

# Or locally
npm install
npm run test:coverage
```

Output: 30 tests, 88% line coverage (requirement ≥70%).

## Key Design Decisions

### Multi-tenancy
Every protected resource query is scoped by `tenant_id`. A user from TenantA calling `/api/projects/:id` for a TenantB project gets 404 — not 403 — to avoid leaking the existence of the resource.

### Connection pooling
The app connects to pgBouncer, not Postgres directly. Transaction pool mode means a server connection is held only for the duration of a single transaction, then returned to the pool — optimal for stateless HTTP workloads.

### Atomic transactions
`POST /api/projects/complex-create` runs a full `BEGIN → INSERT project → INSERT project_users → COMMIT` cycle. Passing `"shouldFail": true` triggers a duplicate insert which causes a constraint violation, rolling back both inserts and leaving the DB unchanged.

### RBAC
The `requireRole('admin')` middleware checks `req.user.role` from the verified JWT. Members hitting admin routes receive 403 Forbidden immediately, before any DB query runs.

### Rate limiting
`POST /api/auth/login` allows 10 requests per minute per IP. The 11th request gets HTTP 429 with a `Retry-After: 60` header.

### Structured logging
Every HTTP request emits one JSON log line to stdout:

```json
{
  "level": "info",
  "message": "HTTP request",
  "timestamp": "2026-05-06T18:21:20.729Z",
  "correlationId": "c1b5867c-bf30-4bd0-a5b0-b1e57ca31ad9",
  "method": "GET",
  "url": "/api/health",
  "statusCode": 200,
  "duration": 45
}
```

The `correlationId` is taken from the `x-correlation-id` request header if present, or generated as a new UUID — enabling end-to-end request tracing across services.

## Ports

| Service | Host port |
|---|---|
| App API | 4000 |
| PostgreSQL | 5433 |
| pgBouncer | 5434 |
| Redis | 6379 |

## Verification Commands

### Health check
```
curl http://localhost:4000/api/health
```
### Create tenant
```
curl -X POST http://localhost:4000/api/tenants \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme Corp"}'
```
### Get JWT
```
curl "http://localhost:4000/api/auth/google/callback?code=mock_valid_code&state=xyz"
```
### Use JWT (replace TOKEN)
```
curl http://localhost:4000/api/me \
  -H "Authorization: Bearer TOKEN"
```
### Pool stats
```
curl http://localhost:4000/api/health/db-pool
```
### Swagger docs
```
open http://localhost:4000/api-docs
```
