export default function LauncherBadge({ launcherName, displayName, primary = false }) {
  const colorClasses = primary
    ? 'bg-blue-600 text-white'
    : 'bg-gray-700 text-gray-300 opacity-70';

  return (
    <span className={`inline-flex items-center rounded-full text-sm font-medium px-2.5 py-0.5 ${colorClasses}`}>
      {displayName || launcherName}
    </span>
  );
}
