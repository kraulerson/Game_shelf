import { getLauncherIcon } from '../utils/launcherIcons';

export default function LauncherBadge({ launcherName, displayName, compact = false, primary = false }) {
  const icon = getLauncherIcon(launcherName);
  const baseClasses = 'inline-flex items-center gap-1 rounded-full text-xs font-medium';
  const colorClasses = primary
    ? 'bg-blue-600 text-white px-2 py-0.5'
    : 'bg-gray-700 text-gray-300 px-2 py-0.5 opacity-70';

  return (
    <span className={`${baseClasses} ${colorClasses}`}>
      <span>{icon}</span>
      {!compact && <span>{displayName}</span>}
    </span>
  );
}
