import CacheBadge from './CacheBadge';
import {
  storesDisagree,
  layoutStoreLine,
  ITEM_SEPARATOR,
  STATUS_SECTION_HEIGHT_CLASS,
} from '../../utils/perStoreStatus';

/**
 * The library card's status row (#31) — a FIXED-height section, reserved on every
 * card whether or not it has anything to show, so a row of cards never goes
 * ragged. Inside it:
 *  - stores agree (or there is one store — 1935 of 2247 games): the single
 *    primary CacheBadge, exactly as before;
 *  - stores disagree: a condensed per-store line, primary store first, laid out
 *    by layoutStoreLine() so it can never wrap out of the reserved height.
 * The complete, uncondensed list is always in the title/aria-label.
 */
export default function CardStatusSection({ stores = [], badge, loading = false }) {
  // While the bulk cache query is still in flight every tracked store reads
  // "Unknown", which would look like a disagreement and flash a per-store line
  // onto every multi-store card. Say nothing until the data is actually in.
  const disagree = !loading && storesDisagree(stores);
  const { shown, overflow } = disagree ? layoutStoreLine(stores) : { shown: [], overflow: 0 };
  const accessible = stores.map((s) => s.accessibleText).join(ITEM_SEPARATOR);

  return (
    <div
      data-testid="card-status"
      className={`mt-1 ${STATUS_SECTION_HEIGHT_CLASS} flex items-center overflow-hidden`}
    >
      {disagree ? (
        <span
          data-testid="per-store-line"
          title={accessible}
          aria-label={accessible}
          className="inline-flex items-center whitespace-nowrap overflow-hidden text-[10px] leading-none text-gray-300"
        >
          {shown.map((s, i) => (
            <span key={s.launcherName} className="inline-flex items-center whitespace-nowrap">
              {i > 0 && <span aria-hidden="true" className="text-gray-600 px-1">·</span>}
              {s.text}
            </span>
          ))}
          {overflow > 0 && (
            <>
              <span aria-hidden="true" className="text-gray-600 px-1">·</span>
              <span data-testid="per-store-overflow" className="text-gray-400">{`+${overflow}`}</span>
            </>
          )}
        </span>
      ) : (
        <CacheBadge {...badge} />
      )}
    </div>
  );
}
