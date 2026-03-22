const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const TEST_SECRET = 'test-jwt-secret-for-middleware';

describe('Auth middleware', () => {
  let authMiddleware;

  before(() => {
    process.env.GAMESHELF_JWT_SECRET = TEST_SECRET;
    authMiddleware = require('../../src/middleware/auth');
  });

  function createMockReqRes(cookieToken) {
    const req = {
      cookies: cookieToken ? { gameshelf_session: cookieToken } : {},
    };
    const res = {
      _status: null,
      _body: null,
      status(code) { this._status = code; return this; },
      json(data) { this._body = data; return this; },
    };
    return { req, res };
  }

  it('should attach req.user and call next() with valid JWT', (_, done) => {
    const token = jwt.sign({ id: 1, username: 'admin' }, TEST_SECRET, { expiresIn: '1h' });
    const { req, res } = createMockReqRes(token);

    authMiddleware(req, res, () => {
      assert.equal(req.user.id, 1);
      assert.equal(req.user.username, 'admin');
      done();
    });
  });

  it('should return 401 when no cookie is present', () => {
    const { req, res } = createMockReqRes(null);
    let nextCalled = false;

    authMiddleware(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { error: 'Unauthorized' });
    assert.equal(nextCalled, false);
  });

  it('should return 401 when JWT is invalid', () => {
    const { req, res } = createMockReqRes('invalid-token');
    let nextCalled = false;

    authMiddleware(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { error: 'Unauthorized' });
    assert.equal(nextCalled, false);
  });

  it('should return 401 when JWT is expired', () => {
    const token = jwt.sign({ id: 1, username: 'admin' }, TEST_SECRET, { expiresIn: '-1s' });
    const { req, res } = createMockReqRes(token);
    let nextCalled = false;

    authMiddleware(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { error: 'Unauthorized' });
    assert.equal(nextCalled, false);
  });

  it('should return 401 when JWT was signed with wrong secret', () => {
    const token = jwt.sign({ id: 1, username: 'admin' }, 'wrong-secret', { expiresIn: '1h' });
    const { req, res } = createMockReqRes(token);
    let nextCalled = false;

    authMiddleware(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { error: 'Unauthorized' });
    assert.equal(nextCalled, false);
  });
});
