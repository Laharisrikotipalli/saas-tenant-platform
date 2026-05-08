const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/:projectId', authenticate, async (req, res) => {
  const { projectId } = req.params;

  try {
    const result = await pool.query(
      'SELECT id, name, tenant_id FROM projects WHERE id = $1',
      [projectId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    const project = result.rows[0];
    if (project.tenant_id !== req.user.tenantId) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json(project);
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

    const projectResult = await client.query(
      'INSERT INTO projects (name, tenant_id) VALUES ($1, $2) RETURNING id, name, tenant_id',
      [projectName, req.user.tenantId]
    );
    const project = projectResult.rows[0];

    await client.query(
      'INSERT INTO project_users (project_id, user_id) VALUES ($1, $2)',
      [project.id, req.user.id]
    );

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
