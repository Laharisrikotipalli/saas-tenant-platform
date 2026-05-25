const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/:projectId', authenticate, async (req, res) => {
  const { projectId } = req.params;

  try {
    // Tenant isolation enforced at the DB level — not in application code after the fact
    const result = await pool.query(
      'SELECT id, name, tenant_id FROM projects WHERE id = $1 AND tenant_id = $2',
      [projectId, req.user.tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json(result.rows[0]);
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/complex-create', authenticate, async (req, res) => {
  const { projectName, shouldFail } = req.body;

  if (!projectName || typeof projectName !== 'string') {
    return res.status(400).json({ error: 'projectName is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert the project scoped to this tenant
    const projectResult = await client.query(
      'INSERT INTO projects (name, tenant_id) VALUES ($1, $2) RETURNING id, name, tenant_id',
      [projectName, req.user.tenantId]
    );
    const project = projectResult.rows[0];

    // Associate the creating user with the project
    await client.query(
      'INSERT INTO project_users (project_id, user_id) VALUES ($1, $2)',
      [project.id, req.user.id]
    );

    // Deliberately trigger a duplicate insert to demonstrate rollback
    if (shouldFail) {
      await client.query(
        'INSERT INTO project_users (project_id, user_id) VALUES ($1, $2)',
        [project.id, req.user.id]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json(project);
  } catch (err) {
    await client.query('ROLLBACK');
    if (shouldFail) {
      return res.status(400).json({ error: 'Transaction rolled back', detail: err.message });
    }
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;