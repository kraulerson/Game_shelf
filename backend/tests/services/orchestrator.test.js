const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

describe('callOrchestrator', () => {
  let mock;
  let lastAuth;
  before(async () => {
    process.env.ORCH_TOKEN = 'test-orch-token';
    mock = await startMock((req, res) => {
      lastAuth = req.headers.authorization; // record on every request
      if (req.url === '/api/v1/ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ hello: 'world' }));
      }
      if (req.url === '/api/v1/unauth') {
        res.writeHead(401);
        return res.end(JSON.stringify({ detail: 'no' }));
      }
      if (req.url === '/api/v1/missing') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ detail: 'game not found' }));
      }
      res.writeHead(500);
      res.end();
    });
    process.env.ORCH_API_URL = mock.url;
  });
  after(() => mock.server.close());

  it('returns {status,data} on success and injects the bearer token', async () => {
    const { callOrchestrator } = require('../../src/services/orchestrator');
    const r = await callOrchestrator('GET', '/api/v1/ok');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { hello: 'world' });
    assert.equal(lastAuth, 'Bearer test-orch-token'); // token injected server-side
  });

  it('maps orchestrator 401 -> 502', async () => {
    const { callOrchestrator } = require('../../src/services/orchestrator');
    await assert.rejects(
      () => callOrchestrator('GET', '/api/v1/unauth'),
      (e) => e.status === 502
    );
  });

  it('passes through a non-401 error status + body', async () => {
    const { callOrchestrator } = require('../../src/services/orchestrator');
    const r = await callOrchestrator('GET', '/api/v1/missing');
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { detail: 'game not found' });
  });

  it('maps connection refused -> 503 orchestrator_offline', async () => {
    process.env.ORCH_API_URL = 'http://127.0.0.1:1'; // nothing listening
    const { callOrchestrator } = require('../../src/services/orchestrator');
    await assert.rejects(
      () => callOrchestrator('GET', '/api/v1/ok'),
      (e) => e.status === 503 && e.body.status === 'orchestrator_offline'
    );
    process.env.ORCH_API_URL = mock.url; // restore
  });

  it('throws 503 orchestrator_offline when ORCH_API_URL is unset', async () => {
    const saved = process.env.ORCH_API_URL;
    delete process.env.ORCH_API_URL;
    const { callOrchestrator } = require('../../src/services/orchestrator');
    await assert.rejects(
      () => callOrchestrator('GET', '/api/v1/ok'),
      (e) => e.status === 503
    );
    process.env.ORCH_API_URL = saved;
  });
});
