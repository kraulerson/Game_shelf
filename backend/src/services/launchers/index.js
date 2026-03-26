const SteamLauncher = require('./steam');
const HumbleLauncher = require('./humble');
const ItchioLauncher = require('./itchio');
const GOGLauncher = require('./gog');
const EALauncher = require('./ea');
const UbisoftLauncher = require('./ubisoft');
const EpicLauncher = require('./epic');
const BattlenetLauncher = require('./battlenet');
const XboxLauncher = require('./xbox');
const AmazonLauncher = require('./amazon');

const LAUNCHER_CLASSES = {
  steam: SteamLauncher,
  humble: HumbleLauncher,
  itchio: ItchioLauncher,
  gog: GOGLauncher,
  ea: EALauncher,
  ubisoft: UbisoftLauncher,
  epic: EpicLauncher,
  battlenet: BattlenetLauncher,
  xbox: XboxLauncher,
  amazon: AmazonLauncher,
};

module.exports = { LAUNCHER_CLASSES };
