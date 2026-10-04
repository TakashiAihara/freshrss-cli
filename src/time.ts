import { UsageError } from "./errors.ts";

/**
 * `--since`, `--until` and `--before` take ISO 8601 or Unix seconds; the API only speaks Unix seconds.
 * Anything else is a usage error rather than a silently ignored bound.
 */
export const unixSeconds = (value: string, flag: string): number => {
  if (/^\d+$/.test(value)) return Number(value);

  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new UsageError(`${flag} is neither an ISO 8601 date nor Unix seconds: ${value}`);
  }
  return Math.floor(milliseconds / 1000);
};
