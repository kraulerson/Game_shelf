function detectEditionTier(title) {
  const lower = title.toLowerCase();
  if (/\bfinal cut\b/.test(lower)) return 10;
  if (/\bdirector[\u2019']?s cut\b/.test(lower)) return 9;
  if (/\bdefinitive\b/.test(lower)) return 8;
  if (/\bspecial edition\b/.test(lower)) return 7;
  if (/\benhanced\b|\bremastered\b/.test(lower)) return 6;
  if (/\bcomplete\s+(edition|collection|pack)\b/.test(lower)) return 5;
  if (/\bgoty\b|\bgame of the year\b/.test(lower)) return 4;
  if (/\bultimate\b|\bpremium\b|\bcollector[\u2019']?s\b|\blegendary\b|\blimited edition\b/.test(lower)) return 3;
  if (/\bgold edition\b/.test(lower)) return 2;
  if (/\bdeluxe\b/.test(lower)) return 1;
  return 0;
}

const TIER_LABELS = [
  'Standard', 'Deluxe', 'Gold', 'Premium', 'GOTY',
  'Complete', 'Enhanced', 'Special', 'Definitive',
  "Director's Cut", 'Final Cut'
];

function getTierLabel(tier) {
  return TIER_LABELS[tier] || 'Standard';
}

module.exports = { detectEditionTier, getTierLabel, TIER_LABELS };
