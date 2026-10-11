import { afterAll, beforeAll, expect, test } from "bun:test";
import { cli, type Env, ok } from "./env";

// Answers the real FreshRSS in cli.test.ts never gives, or gives in a form the CLI's result cannot tell apart.
let server: ReturnType<typeof Bun.serve>;
let env: Env;
const requests: URL[] = [];
// The `s` of every subscription/edit, in the order sent.
const unsubscribed: string[] = [];

// Pages for stream/contents, chosen by the `c` the CLI sends: `empty` keeps naming a new continuation with no items,
// `stuck` repeats the same continuation with an item. Both end after a few pages so a broken guard ends the test.
const page = (c: string | null): unknown => {
  const [kind, n] = (c ?? "empty-0").split("-");
  const next = Number(n) + 1;
  if (kind === "stuck") {
    // The continuation never changes, so the bound is the number of times it was asked for.
    const asked = requests.filter((r) => r.searchParams.get("c") === "stuck-0").length;
    return asked > 4 ? { items: [] } : { items: [{ id: "x" }], continuation: "stuck-0" };
  }
  if (next > 4) return { items: [] };
  return { items: [], continuation: `empty-${next}` };
};

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      requests.push(url);
      const path = url.pathname.replace("/api/greader.php", "");
      // feed/1 and feed/3 can be removed; feed/2 is refused the way the server refuses a feed.
      if (path === "/reader/api/0/subscription/edit") {
        const s = new URLSearchParams(await req.text()).get("s");
        unsubscribed.push(s ?? "");
        return s === "feed/2" ? new Response("Bad Request!", { status: 400 }) : new Response("OK");
      }
      if (path === "/accounts/ClientLogin") return new Response("SID=x\nLSID=x\nAuth=fake\n");
      if (path === "/reader/api/0/token") return new Response("fake-token\n");
      if (path === "/reader/api/0/edit-tag") return new Response("Done");
      if (path === "/reader/api/0/stream/contents")
        return Response.json(page(url.searchParams.get("c")));
      return new Response("unexpected", { status: 500 });
    },
  });
  env = {
    base: `http://127.0.0.1:${server.port}`,
    apiPassword: "fake",
    feedUrl: "",
    stop: async () => undefined,
  };
});

afterAll(() => {
  server.stop(true);
});

const contents = (): URL[] => requests.filter((r) => r.pathname.endsWith("/stream/contents"));

test("a write answered 200 without OK is a failure (exit 1)", async () => {
  const r = await cli(env, ["mark", "read", "1"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("without OK: Done");
});

test("--all stops at an empty page even when it names another continuation", async () => {
  requests.length = 0;
  expect(ok<{ items: unknown[] }>(await cli(env, ["entries", "--all"]))).toEqual({ items: [] });
  expect(contents().length).toBe(1);
});

test("--all stops when the continuation does not move forward", async () => {
  requests.length = 0;
  ok(await cli(env, ["entries", "--all", "-c", "stuck-0"]));
  expect(contents().length).toBe(1);
});

test("--stream toString is sent as a stream id, not read from an inherited property", async () => {
  requests.length = 0;
  ok(await cli(env, ["entries", "--stream", "toString"]));
  const [sent] = contents();
  expect(sent?.searchParams.get("s")).toBe("toString");
  expect(sent?.searchParams.has("it")).toBe(false);
});

test("subs rm stops at the first failure and names what was removed and what was not attempted", async () => {
  unsubscribed.length = 0;
  const r = await cli(env, ["subs", "rm", "1", "2", "3"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain(
    "removed: feed/1; feed/2 failed: the server refused the request (HTTP 400): Bad Request!; not attempted: feed/3",
  );
  expect(unsubscribed).toEqual(["feed/1", "feed/2"]);
});

test("subs rm failing at its first feed says none was removed and sends nothing after it", async () => {
  unsubscribed.length = 0;
  const r = await cli(env, ["subs", "rm", "2", "1"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("removed: none; feed/2 failed: ");
  expect(r.stderr).toContain("; not attempted: feed/1");
  expect(unsubscribed).toEqual(["feed/2"]);
});

test("subs rm of a single feed reports the server's refusal as is", async () => {
  const r = await cli(env, ["subs", "rm", "2"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toBe("freshrss: the server refused the request (HTTP 400): Bad Request!\n");
});
