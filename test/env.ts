import { spawn } from "bun";

// One throwaway FreshRSS per test file, in Docker, plus a feed server on the host that the container can reach.
// Nothing here points at a real instance.

const IMAGE = "freshrss/freshrss:latest";
export const USER = "test";

export const FEED_ITEMS = [
  { guid: "item-1", title: "First", date: "2026-01-01T00:00:00Z" },
  { guid: "item-2", title: "Second", date: "2026-01-02T00:00:00Z" },
  { guid: "item-3", title: "Third", date: "2026-01-03T00:00:00Z" },
];

const rss = (base: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Local feed</title><link>${base}/</link><description>test</description>
${FEED_ITEMS.map(
  (i) => `<item><guid>${i.guid}</guid><title>${i.title}</title><link>${base}/${i.guid}</link>
<description>Body of ${i.title}</description><pubDate>${new Date(i.date).toUTCString()}</pubDate></item>`,
).join("\n")}
</channel></rss>`;

export type Env = {
  base: string;
  apiPassword: string;
  // URL of the feed as the container sees it.
  feedUrl: string;
  stop: () => Promise<void>;
};

const run = async (cmd: string[]): Promise<string> => {
  const p = spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} ${cmd[1]} exited ${code}: ${err}`);
  return out.trim();
};

export const start = async (): Promise<Env> => {
  // The container reaches the host at the bridge gateway, so the feed server listens on every interface. The feed is
  // addressed by that IP, not by a name from --add-host: FreshRSS resolves feed hosts with dns_get_record(), which
  // does not read /etc/hosts, and refuses a host it cannot resolve.
  const gateway = await run([
    "docker",
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  let feedBase = "";
  const feeds = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch: (): Response =>
      new Response(rss(feedBase), { headers: { "Content-Type": "application/rss+xml" } }),
  });
  feedBase = `http://${gateway}:${feeds.port}`;

  const webPassword = crypto.randomUUID();
  const apiPassword = crypto.randomUUID();
  const name = `freshrss-cli-test-${process.pid}-${Date.now()}`;

  const stop = async (): Promise<void> => {
    feeds.stop(true);
    await run(["docker", "rm", "-f", name]).catch(() => undefined);
  };

  try {
    await run([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      "127.0.0.1::80",
      "-e",
      `INTERNAL_HOST_ALLOWLIST=${gateway}:${feeds.port}`,
      "-e",
      `FRESHRSS_INSTALL=--api-enabled --default-user ${USER} --base-url http://localhost`,
      "-e",
      `FRESHRSS_USER=--user ${USER} --password ${webPassword} --api-password ${apiPassword} --no-default-feeds`,
      IMAGE,
    ]);
    const port = (await run(["docker", "port", name, "80/tcp"])).split(":").at(-1);
    const base = `http://127.0.0.1:${port}`;

    // The user is created by the entrypoint after the web server is up, so wait for a login that succeeds.
    const deadline = Date.now() + 90_000;
    for (;;) {
      const res = await fetch(`${base}/api/greader.php/accounts/ClientLogin`, {
        method: "POST",
        body: new URLSearchParams({ Email: USER, Passwd: apiPassword }),
      }).catch(() => undefined);
      if (res?.status === 200) break;
      if (Date.now() > deadline)
        throw new Error(`FreshRSS did not accept the login within 90s (last: ${res?.status})`);
      await Bun.sleep(1000);
    }

    return { base, apiPassword, feedUrl: `${feedBase}/feed.xml`, stop };
  } catch (e) {
    await stop();
    throw e;
  }
};

export type Result = { code: number; stdout: string; stderr: string };

export const cli = async (
  env: Env,
  args: string[],
  opts: { stdin?: string; vars?: Record<string, string | undefined> } = {},
): Promise<Result> => {
  const vars: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    FRESHRSS_URL: env.base,
    FRESHRSS_USER: USER,
    FRESHRSS_API_PASSWORD: env.apiPassword,
    ...opts.vars,
  };
  const p = spawn(["bun", "src/cli.ts", ...args], {
    cwd: `${import.meta.dir}/..`,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    // spawn passes an undefined value as the string "undefined", so drop the keys a test unsets.
    env: Object.fromEntries(
      Object.entries(vars).filter((kv): kv is [string, string] => kv[1] !== undefined),
    ),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
};

// Parses stdout as JSON and fails with the CLI's stderr when the command did not succeed.
export const ok = <T = unknown>(r: Result): T => {
  if (r.code !== 0) throw new Error(`exit ${r.code}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
  return JSON.parse(r.stdout) as T;
};
