const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');

function requestLogger(req, res, next) {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  const start = Date.now();

  res.on('finish', () => {
    logger.info('HTTP request', {
      level: 'info',
      message: 'HTTP request',
      timestamp: new Date().toISOString(),
      correlationId,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      duration: Date.now() - start,
    });
  });

  next();
}

module.exports = requestLogger;
