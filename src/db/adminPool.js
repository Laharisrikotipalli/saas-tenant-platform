const { Pool } = require('pg');

// Connect to pgBouncer admin database for pool stats
const adminPool = new Pool({
  host: process.env.PGBOUNCER_HOST || 'pgbouncer',
  port: process.env.PGBOUNCER_PORT || 5432,
  user: process.env.PGBOUNCER_ADMIN_USER || 'pgbouncer_admin',
  password: process.env.PGBOUNCER_ADMIN_PASSWORD || 'secret',
  database: 'pgbouncer',
});

module.exports = adminPool;
