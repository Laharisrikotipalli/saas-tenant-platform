const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');

const requestLogger = require('./utils/requestLogger');
const { authenticate } = require('./middleware/auth');

const healthRoutes = require('./routes/health');
const tenantRoutes = require('./routes/tenants');
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(requestLogger);

app.use('/api/health', healthRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);

app.get('/api/me', authenticate, async (req, res) => {
  const pool = require('./db/pool');
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.tenant_id AS "tenantId", ur.role
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json(result.rows[0]);
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'SaaS Platform API Running' });
});

const swaggerDoc = {
  openapi: '3.0.0',
  info: { title: 'SaaS Platform API', version: '1.0.0' },
  paths: {
    '/api/health': { get: { summary: 'Health check', responses: { 200: { description: 'Healthy' } } } },
    '/api/tenants': { post: { summary: 'Create tenant', responses: { 201: { description: 'Created' } } } },
    '/api/me': { get: { summary: 'Get current user', responses: { 200: { description: 'User info' } } } },
    '/api/auth/login': { post: { summary: 'Login', responses: { 200: { description: 'JWT tokens' } } } },
    '/api/auth/google/callback': { get: { summary: 'Google OAuth callback', responses: { 200: { description: 'JWT tokens' } } } },
    '/api/projects/{projectId}': { get: { summary: 'Get project', responses: { 200: { description: 'Project' } } } },
  },
};

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
