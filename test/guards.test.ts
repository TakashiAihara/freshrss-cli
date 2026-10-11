import { afterAll, beforeAll, expect, test } from "bun:test";
import { cli, type Env } from "./env";

// Guards for answers the real FreshRSS does not give, so the Docker server in cli.test.ts cannot reach them.
let server: ReturnType<typeof Bun.serve>;
let env: Env;
const requests: URL[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req: Request): Response => {
      const url = new URL(req.url);
      requests.push(url);
      const path = url.pathname.replace("/api/greader.php", "");
      if (path === "/accounts/ClientLogin") return new Response("SID=x\nLSID=x\nAuth=fake\n");
      if (path === "/reader/api/0/token") return new Response("fake-token\n");
      if (path === "/reader/api/0/edit-tag") return new Response("Done");
      if (path === "/reader/api/0/stream/contents") {
        // Every page is empty and names another continuation, up to a bound so a broken guard ends the test.
        const pages = requests.filter((r) => r.pathname.endsWith("/stream/contents")).length;
        return Response.json(pages < 5 ? { items: [], continuation: `c${pages}` } : { items: [] });
      }
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
  const r = await cli(env, ["entries", "--all"]);
  expect(JSON.parse(r.stdout)).toEqual({ items: [] });
  expect(contents().length).toBe(1);
});

test("--stream toString is sent as a stream id, not read from an inherited property", async () => {
  requests.length = 0;
  await cli(env, ["entries", "--stream", "toString"]);
  const [sent] = contents();
  expect(sent?.searchParams.get("s")).toBe("toString");
  expect(sent?.searchParams.has("it")).toBe(false);
});
