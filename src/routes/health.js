const express = require('express');
const pool = require('../db/pool');
const redis = require('../services/redis');

const router = express.Router();

router.get('/', async (req, res) => {
  const services = { database: 'healthy', cache: 'healthy' };
  let status = 'ok';
  let httpStatus = 200;

  try {
    await pool.query('SELECT 1');
  } catch {
    services.database = 'unhealthy';
    status = 'error';
    httpStatus = 503;
  }

  try {
    await redis.ping();
  } catch {
    services.cache = 'unhealthy';
    status = 'error';
    httpStatus = 503;
  }

  return res.status(httpStatus).json({ status, services });
});

router.get('/db-pool', async (req, res) => {
  try {
    const adminPool = require('../db/adminPool');
    const result = await adminPool.query("SHOW POOLS");
    const row = result.rows[0] || {};
    return res.json({
      total_connections: parseInt(row.cl_active || 0) + parseInt(row.cl_waiting || 0) + parseInt(row.sv_idle || 0),
      idle_connections: parseInt(row.sv_idle || 0),
      active_connections: parseInt(row.sv_active || 0),
      pool_mode: 'transaction',
    });
  } catch {
    return res.json({
      total_connections: pool.totalCount,
      idle_connections: pool.idleCount,
      active_connections: pool.totalCount - pool.idleCount,
      pool_mode: 'transaction',
    });
  }
});

module.exports = router;
