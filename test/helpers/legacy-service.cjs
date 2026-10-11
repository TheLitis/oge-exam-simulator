'use strict';
const service = require('../../src/service.cjs');
const server = require('../../src/server.cjs');

// Historical fixtures deliberately model unconfigured, plaintext versions.
// The production default and new protection tests always use the real entry points.
class ExamService extends service.ExamService {
  constructor(root, options = {}) { super(root, { ...options, allowLegacyResults: true }); }
}
function startServer(options = {}) { return server.startServer({ ...options, allowLegacyResults: true }); }

module.exports = { ...service, ...server, ExamService, startServer };
