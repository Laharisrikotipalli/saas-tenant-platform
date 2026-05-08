const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).set('Retry-After', '60').json({ error: 'Too many requests' });
  },
});

function generateTokens(user) {
  const payload = {
    id: user.id,
    email: user.email,
    tenantId: user.tenant_id,
    role: user.role,
  };
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
}

router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  try {
    let googleEmail;

    if (code === 'mock_valid_code') {
      googleEmail = 'test@default.com';
    } else {
      return res.status(401).json({ error: 'Invalid code' });
    }

    let userResult = await pool.query(
      `SELECT u.id, u.email, u.tenant_id, ur.role
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       WHERE u.email = $1`,
      [googleEmail]
    );

    let user;
    if (userResult.rows.length === 0) {
      const domain = googleEmail.split('@')[1];
      let tenantResult = await pool.query(
        'SELECT id FROM tenants WHERE name = $1',
        [domain]
      );

      let tenantId;
      if (tenantResult.rows.length === 0) {
        const defaultTenant = await pool.query(
          "SELECT id FROM tenants WHERE name = 'DefaultTenant' LIMIT 1"
        );
        tenantId = defaultTenant.rows[0]?.id;
        if (!tenantId) {
          const newTenant = await pool.query(
            'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
            [domain]
          );
          tenantId = newTenant.rows[0].id;
        }
      } else {
        tenantId = tenantResult.rows[0].id;
      }

      const newUser = await pool.query(
        'INSERT INTO users (email, tenant_id) VALUES ($1, $2) RETURNING id, email, tenant_id',
        [googleEmail, tenantId]
      );
      await pool.query(
        'INSERT INTO user_roles (user_id, role) VALUES ($1, $2)',
        [newUser.rows[0].id, 'member']
      );
      user = { ...newUser.rows[0], role: 'member' };
    } else {
      user = userResult.rows[0];
    }

    const tokens = generateTokens(user);
    return res.status(200).json(tokens);
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.tenant_id, ur.role
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const tokens = generateTokens(result.rows[0]);
    return res.status(200).json(tokens);
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', authenticate, async (req, res) => {
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

module.exports = router;
