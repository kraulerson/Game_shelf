const SGDB = require('steamgriddb').default || require('steamgriddb');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getClient() {
  const apiKey = process.env.STEAMGRIDDB_API_KEY;
  if (!apiKey) return null;
  return new SGDB(apiKey);
}

async function searchGame(title) {
  const client = getClient();
  if (!client) return null;

  try {
    const results = await client.searchGame(title);
    return results || null;
  } catch (err) {
    console.error('[SteamGridDB] Search failed:', err.message);
    return null;
  }
}

async function getImages(sgdbGameId) {
  const client = getClient();
  if (!client) return { coverUrl: null, heroUrl: null };

  let coverUrl = null;
  let heroUrl = null;

  try {
    const grids = await client.getGridsById(sgdbGameId);
    if (grids && grids.length > 0) {
      coverUrl = grids[0].url;
    }
  } catch (err) {
    console.warn('[SteamGridDB] Grid fetch failed:', err.message);
  }

  await sleep(500);

  try {
    const heroes = await client.getHeroesById(sgdbGameId);
    if (heroes && heroes.length > 0) {
      heroUrl = heroes[0].url;
    }
  } catch (err) {
    console.warn('[SteamGridDB] Hero fetch failed:', err.message);
  }

  return { coverUrl, heroUrl };
}

async function getImagesBySteamAppId(steamAppId) {
  const client = getClient();
  if (!client) return { coverUrl: null, heroUrl: null };

  let coverUrl = null;
  let heroUrl = null;

  try {
    const grids = await client.getGridsBySteamAppId(Number(steamAppId));
    if (grids && grids.length > 0) {
      coverUrl = grids[0].url;
    }
  } catch (err) {
    console.warn('[SteamGridDB] Grid by Steam ID failed:', err.message);
  }

  await sleep(500);

  try {
    const heroes = await client.getHeroesBySteamAppId(Number(steamAppId));
    if (heroes && heroes.length > 0) {
      heroUrl = heroes[0].url;
    }
  } catch (err) {
    console.warn('[SteamGridDB] Hero by Steam ID failed:', err.message);
  }

  return { coverUrl, heroUrl };
}

module.exports = { searchGame, getImages, getImagesBySteamAppId };
