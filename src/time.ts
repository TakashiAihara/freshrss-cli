import { UsageError } from "./errors.ts";

// A date (UTC midnight), or a date and time with Z or an offset. A time without an offset is refused: it would be read
// in the local zone, which differs between the machines a script runs on.
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/;

// Date.parse rolls 2026-02-30 over to 2026-03-02 instead of refusing it, so the calendar date is checked on its own.
const realDate = (value: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m === null) return true;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
};

/**
 * `--since`, `--until` and `--before` take ISO 8601 or Unix seconds; the API only speaks Unix seconds. Unix seconds
 * are digits only and ISO 8601 always has the dashes of a date, so `2026` or `20261004` is read as seconds, never as a
 * year. Anything else is a usage error rather than a silently ignored bound.
 */
export const unixSeconds = (value: string, flag: string): number => {
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : ISO.test(value)
      ? Math.floor(Date.parse(value) / 1000)
      : NaN;
  if (!Number.isSafeInteger(seconds) || !realDate(value)) {
    throw new UsageError(
      `${flag} takes Unix seconds or an ISO 8601 date (2026-10-04) or date-time with an offset (2026-10-04T09:00:00+09:00), not ${value}`,
    );
  }
  return seconds;
};
