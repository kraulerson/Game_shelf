const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.resolve(path.dirname(process.env.GAMESHELF_DB_PATH || './data/gameshelf.db'));
const imagesDir = path.join(dataDir, 'images');

/**
 * Transform IGDB image URLs to full-size versions.
 * IGDB returns: //images.igdb.com/igdb/image/upload/t_thumb/{hash}.jpg
 * We want: https://images.igdb.com/igdb/image/upload/t_cover_big/{hash}.jpg
 */
function transformIgdbUrl(url, type) {
  if (!url) return null;
  let transformed = url;

  // Prepend https: if needed
  if (transformed.startsWith('//')) {
    transformed = 'https:' + transformed;
  }

  // Replace thumbnail size with full size
  if (type === 'cover' || type === 'icon') {
    transformed = transformed.replace('/t_thumb/', '/t_cover_big/');
  } else if (type === 'hero') {
    transformed = transformed.replace('/t_thumb/', '/t_screenshot_big/');
  }

  return transformed;
}

async function cacheImage(url, gameId, type) {
  if (!url) return null;

  const fullUrl = transformIgdbUrl(url, type);
  if (!fullUrl) return null;

  // Derive extension from URL
  const urlPath = new URL(fullUrl).pathname;
  const ext = path.extname(urlPath) || '.jpg';

  const gameDir = path.join(imagesDir, String(gameId));
  fs.mkdirSync(gameDir, { recursive: true });

  const filename = `${type}${ext}`;
  const filePath = path.join(gameDir, filename);

  const res = await axios.get(fullUrl, { responseType: 'arraybuffer' });
  fs.writeFileSync(filePath, res.data);

  // Return the URL path the frontend will use
  return `/data/images/${gameId}/${filename}`;
}

function getLocalPath(gameId, type) {
  const gameDir = path.join(imagesDir, String(gameId));
  if (!fs.existsSync(gameDir)) return null;

  const files = fs.readdirSync(gameDir);
  const match = files.find(f => f.startsWith(type + '.'));
  return match ? `/data/images/${gameId}/${match}` : null;
}

module.exports = { cacheImage, getLocalPath, transformIgdbUrl };
