import {
  CheckCircle,
  Download,
  ArrowUpCircle,
  Circle,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Ban,
  Minus,
  CloudOff,
} from 'lucide-react';
import { cacheBadgeFor } from '../../utils/cacheBadge';
import { formatMeasuredAge } from '../../utils/measuredAge';

const ICONS = {
  CheckCircle,
  Download,
  ArrowUpCircle,
  Circle,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Ban,
  Minus,
  CloudOff,
};

const TONE = {
  green: 'bg-green-700 text-green-100',
  blue: 'bg-blue-700 text-blue-100',
  amber: 'bg-amber-600 text-amber-50',
  red: 'bg-red-700 text-red-100',
  gray: 'bg-gray-700 text-gray-200',
  slate: 'bg-slate-600 text-slate-100',
  neutral: 'bg-gray-800 text-gray-400',
};

export default function CacheBadge({
  status,
  blocked,
  tracked = true,
  offline = false,
  chunksCached,
  chunksTotal,
  size = 'default',
  badge,
  measuredAt,
}) {
  // `badge` is a pre-computed { icon, tone, label } descriptor (e.g. a GOG
  // manual-download badge). When provided it overrides the lancache cache-status
  // computation; otherwise the badge is derived from the cache status.
  const { icon, tone, label } = badge || cacheBadgeFor({ status, blocked, tracked, offline, chunksCached, chunksTotal });
  const Icon = ICONS[icon];
  const sizeClasses = size === 'small' ? 'text-xs px-1.5 py-0.5 gap-0.5' : 'text-sm px-2.5 py-0.5 gap-1';
  // How long ago the status was MEASURED (#309). Rendered as a sibling, never
  // folded into `label`: the label feeds the per-store 34-char layout budget, and
  // "Partial · 90% · 2d ago" would overflow the row. Null when never measured, in
  // which case nothing renders at all — an absent measurement must not be dressed
  // up as an empty one.
  const age = formatMeasuredAge(measuredAt);
  return (
    <>
      <span
        className={`inline-flex items-center rounded-full font-medium ${sizeClasses} ${TONE[tone]}`}
        title={label}
      >
        <Icon size={size === 'small' ? 12 : 14} aria-hidden="true" />
        {label}
      </span>
      {age && (
        <span
          data-testid="cache-measured-age"
          className={`text-gray-400 ${size === 'small' ? 'text-[10px]' : 'text-xs'}`}
          title={`Cache status measured ${age}`}
        >
          {age}
        </span>
      )}
    </>
  );
}
