/** The arguments or the environment are wrong: the request was never sent, so the run ends with exit 2. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** The server answered with a failure; its own words go to stderr and the run ends with exit 1. */
export class ServerError extends Error {
  override readonly name = "ServerError";
}
