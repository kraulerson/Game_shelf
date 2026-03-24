export default function LauncherBadge({ launcherName, displayName, primary = false, size = 'default' }) {
  const sizeClasses = size === 'small'
    ? 'text-xs px-1.5 py-0.5'
    : 'text-sm px-2.5 py-0.5';

  const colorClasses = primary
    ? 'bg-blue-600 text-white'
    : 'bg-gray-700 text-gray-300 opacity-70';

  return (
    <span className={`inline-flex items-center rounded-full font-medium ${sizeClasses} ${colorClasses}`}>
      {displayName || launcherName}
    </span>
  );
}
