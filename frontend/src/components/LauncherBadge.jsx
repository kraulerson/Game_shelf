export default function LauncherBadge({
  launcherName,
  displayName,
  primary = false,
  size = 'default',
  // #31: this store's own status, as a SHAPE symbol (never colour alone) plus the
  // full wording, which goes to the tooltip and to screen readers. Both optional —
  // a badge given no status renders exactly as it always has.
  statusSymbol,
  statusLabel,
}) {
  const sizeClasses = size === 'small'
    ? 'text-xs px-1.5 py-0.5'
    : 'text-sm px-2.5 py-0.5';

  const colorClasses = primary
    ? 'bg-blue-600 text-white'
    : 'bg-gray-700 text-gray-300 opacity-70';

  const name = displayName || launcherName;
  const title = statusLabel ? `${name} — ${statusLabel}` : undefined;

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium whitespace-nowrap ${sizeClasses} ${colorClasses}`}
      title={title}
      data-testid={statusSymbol ? 'launcher-status' : undefined}
    >
      {name}
      {statusSymbol && (
        <span className="ml-1 leading-none" aria-hidden="true" data-testid="status-symbol">
          {statusSymbol}
        </span>
      )}
      {statusLabel && <span className="sr-only"> — {statusLabel}</span>}
    </span>
  );
}
