const axios = require('axios');

const TIMEOUT_MS = 5000;
const PAGE = 500;

function offline() {
  return Object.assign(new Error('orchestrator offline'), {
    status: 503,
    body: { status: 'orchestrator_offline' },
  });
}

// Call the lancache orchestrator API. Reads ORCH_API_URL / ORCH_TOKEN lazily so
// the cache feature stays optional (unset -> 503) and tests can vary it.
// - transport error (refused/timeout/abort) OR unset URL -> throw 503 orchestrator_offline
// - orchestrator 401 -> throw 502 (a misconfigured token is an operator problem)
// - any other response (2xx/4xx) -> return { status, data } for the route to pass through
async function callOrchestrator(method, path, { params, data } = {}) {
  const baseURL = process.env.ORCH_API_URL;
  if (!baseURL) throw offline();
  let res;
  try {
    res = await axios({
      method,
      url: baseURL.replace(/\/$/, '') + path,
      params,
      data,
      timeout: TIMEOUT_MS,
      headers: { Authorization: `Bearer ${process.env.ORCH_TOKEN || ''}` },
      validateStatus: () => true, // pass 4xx through; only transport errors throw
    });
  } catch (err) {
    // ECONNREFUSED, ETIMEDOUT, ECONNABORTED (timeout), ENOTFOUND, … all land here.
    throw offline();
  }
  if (res.status === 401) {
    throw Object.assign(new Error('orchestrator auth failed'), {
      status: 502,
      body: { error: 'orchestrator authentication failed' },
    });
  }
  return { status: res.status, data: res.data };
}

// Page through the orchestrator's paginated /games (limit capped at 500) into a
// single merged set for F15's bulk badge correlation.
async function fetchAllGames() {
  const games = [];
  let offset = 0;
  let total = 0;
  // Advance by the actual page length (not the requested limit) so this
  // terminates correctly regardless of the server's page size, and an empty
  // page always breaks the loop — never spins.
  for (;;) {
    const { status, data } = await callOrchestrator('GET', '/api/v1/games', {
      params: { limit: PAGE, offset },
    });
    if (status !== 200) {
      throw Object.assign(new Error('games fetch failed'), { status, body: data });
    }
    const page = data.games || [];
    games.push(...page);
    total = data.meta ? data.meta.total : games.length;
    offset += page.length;
    if (page.length === 0 || games.length >= total) break;
  }
  return { games, meta: { total } };
}

module.exports = { callOrchestrator, fetchAllGames };
