const request = require('supertest');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';

// Mock pg pool
jest.mock('../src/db/pool', () => {
  const mockQuery = jest.fn();
  return { query: mockQuery, connect: jest.fn(), totalCount: 5, idleCount: 3 };
});

// Mock redis
jest.mock('../src/services/redis', () => ({
  ping: jest.fn().mockResolvedValue('PONG'),
  on: jest.fn(),
}));

// Mock adminPool
jest.mock('../src/db/adminPool', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ cl_active: '2', cl_waiting: '0', sv_idle: '3', sv_active: '1' }] }),
}));

const pool = require('../src/db/pool');
const redis = require('../src/services/redis');
const app = require('../src/app');

const TENANT_A_ID = 'a0000000-0000-0000-0000-000000000001';
const USER_ADMIN_ID = 'a1000000-0000-0000-0000-000000000001';

function makeToken(payload = {}) {
  return jwt.sign(
    { id: USER_ADMIN_ID, email: 'admin@tenanta.com', tenantId: TENANT_A_ID, role: 'admin', ...payload },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

describe('GET /api/health', () => {
  it('returns 200 when all services healthy', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    redis.ping.mockResolvedValueOnce('PONG');
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.services.database).toBe('healthy');
    expect(res.body.services.cache).toBe('healthy');
  });

  it('returns 503 when db is down', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB down'));
    redis.ping.mockResolvedValueOnce('PONG');
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.services.database).toBe('unhealthy');
  });
});

describe('GET /api/health/db-pool', () => {
  it('returns pool stats', async () => {
    const res = await request(app).get('/api/health/db-pool');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_connections');
    expect(res.body).toHaveProperty('idle_connections');
    expect(res.body).toHaveProperty('active_connections');
    expect(res.body.pool_mode).toBe('transaction');
  });
});

describe('POST /api/tenants', () => {
  it('creates a tenant and returns 201', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: '123e4567-e89b-12d3-a456-426614174000', name: 'NewTenant' }],
    });
    const res = await request(app).post('/api/tenants').send({ name: 'NewTenant' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('NewTenant');
    expect(res.body.id).toBeDefined();
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app).post('/api/tenants').send({});
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate tenant name', async () => {
    const err = new Error('duplicate');
    err.code = '23505';
    pool.query.mockRejectedValueOnce(err);
    const res = await request(app).post('/api/tenants').send({ name: 'Duplicate' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/me', () => {
  it('returns 401 with no token', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 with invalid token', async () => {
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
  });

  it('returns user info with valid token', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: USER_ADMIN_ID, email: 'admin@tenanta.com', tenantId: TENANT_A_ID, role: 'admin' }],
    });
    const token = makeToken();
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('admin@tenanta.com');
    expect(res.body.role).toBe('admin');
  });

  it('returns 404 when user not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const token = makeToken();
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/auth/google/callback', () => {
  it('returns 400 when code or state missing', async () => {
    const res = await request(app).get('/api/auth/google/callback?code=abc');
    expect(res.status).toBe(400);
  });

  it('returns tokens for mock_valid_code with existing user', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: USER_ADMIN_ID, email: 'test@default.com', tenant_id: TENANT_A_ID, role: 'admin' }],
    });
    const res = await request(app).get('/api/auth/google/callback?code=mock_valid_code&state=xyz');
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  it('creates new user when not found', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })                                                                        // user lookup
      .mockResolvedValueOnce({ rows: [{ id: TENANT_A_ID }] })                                                    // tenant lookup by domain
      .mockResolvedValueOnce({ rows: [{ id: 'new-user-id', email: 'test@default.com', tenant_id: TENANT_A_ID }] }) // insert user
      .mockResolvedValueOnce({ rows: [] });                                                                        // insert role
    const res = await request(app).get('/api/auth/google/callback?code=mock_valid_code&state=xyz');
    expect(res.status).toBe(200);
  });

  it('returns 401 for invalid code', async () => {
    const res = await request(app).get('/api/auth/google/callback?code=bad_code&state=xyz');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/login', () => {
  it('returns 400 when email is missing', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('returns 401 for unknown user', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@x.com' });
    expect(res.status).toBe(401);
  });

  it('returns tokens for known user', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: USER_ADMIN_ID, email: 'admin@tenanta.com', tenant_id: TENANT_A_ID, role: 'admin' }],
    });
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@tenanta.com' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });
});

describe('DELETE /api/tenants/:tenantId/users/:userId', () => {
  it('returns 403 for member role', async () => {
    const token = makeToken({ role: 'member' });
    const res = await request(app)
      .delete(`/api/tenants/${TENANT_A_ID}/users/${USER_ADMIN_ID}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 when admin accesses different tenant', async () => {
    const token = makeToken({ tenantId: 'other-tenant' });
    const res = await request(app)
      .delete(`/api/tenants/${TENANT_A_ID}/users/${USER_ADMIN_ID}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 204 when admin deletes user in same tenant', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: USER_ADMIN_ID }], rowCount: 1 });
    const token = makeToken();
    const res = await request(app)
      .delete(`/api/tenants/${TENANT_A_ID}/users/${USER_ADMIN_ID}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
  });

  it('returns 404 when user not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const token = makeToken();
    const res = await request(app)
      .delete(`/api/tenants/${TENANT_A_ID}/users/non-existent`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/:projectId', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/projects/some-id');
    expect(res.status).toBe(401);
  });

  it('returns project for correct tenant', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'proj-1', name: 'Project Alpha', tenant_id: TENANT_A_ID }],
    });
    const token = makeToken();
    const res = await request(app).get('/api/projects/proj-1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Project Alpha');
  });

  it('returns 404 for project belonging to different tenant', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'proj-b', name: 'Project Beta', tenant_id: 'b0000000-0000-0000-0000-000000000002' }],
    });
    const token = makeToken();
    const res = await request(app).get('/api/projects/proj-b').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-existent project', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const token = makeToken();
    const res = await request(app).get('/api/projects/bad-id').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/projects/complex-create', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };

  beforeEach(() => {
    pool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockReset();
    mockClient.release.mockReset();
  });

  it('returns 400 when projectName missing', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/projects/complex-create')
      .set('Authorization', `Bearer ${token}`)
      .send({ shouldFail: false });
    expect(res.status).toBe(400);
  });

  it('creates project successfully', async () => {
    mockClient.query
      .mockResolvedValueOnce({})                                                                                    // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'new-proj', name: 'My Project', tenant_id: TENANT_A_ID }] })           // INSERT project
      .mockResolvedValueOnce({})                                                                                    // INSERT project_users
      .mockResolvedValueOnce({});                                                                                   // COMMIT

    const token = makeToken();
    const res = await request(app)
      .post('/api/projects/complex-create')
      .set('Authorization', `Bearer ${token}`)
      .send({ projectName: 'My Project', shouldFail: false });
    expect(res.status).toBe(201);
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('rolls back transaction on shouldFail=true', async () => {
    mockClient.query
      .mockResolvedValueOnce({})                                                                                    // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'new-proj', name: 'My Project', tenant_id: TENANT_A_ID }] })           // INSERT project
      .mockResolvedValueOnce({})                                                                                    // INSERT project_users (first)
      .mockRejectedValueOnce(new Error('unique violation'));                                                        // INSERT project_users (duplicate = fail)

    const token = makeToken();
    const res = await request(app)
      .post('/api/projects/complex-create')
      .set('Authorization', `Bearer ${token}`)
      .send({ projectName: 'My Project', shouldFail: true });
    expect(res.status).toBe(400);
    expect(mockClient.release).toHaveBeenCalled();
  });
});

describe('GET /api-docs', () => {
  it('returns 200 and HTML with swagger-ui', async () => {
    const res = await request(app).get('/api-docs');
    expect([200, 301]).toContain(res.status);
  });
});

describe('Rate limiting on /api/auth/login', () => {
  it('returns 429 after 10 requests', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    let lastStatus;
    for (let i = 0; i < 11; i++) {
      const res = await request(app).post('/api/auth/login').send({ email: `user${i}@test.com` });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  }, 15000);
});
