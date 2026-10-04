#!/usr/bin/env bun
// A command-line client for one FreshRSS user, over the Google Reader API.
// Every command prints JSON on stdout (OPML for `subs export`); errors and refusals go to stderr.
// Exit codes: 0 success, 1 the server refused or failed, 2 usage or configuration error (docs/design.md).
import { Command, CommanderError, Option } from "commander";
import {
  disableTag,
  EditSubscriptionBodyAc,
  editSubscription,
  editTag,
  exportSubscriptions,
  getStreamContents,
  getStreamItemContents,
  getStreamItemIds,
  getUnreadCount,
  getUserInfo,
  importSubscriptions,
  IncludeTargetParameter,
  listTags,
  markAllAsRead,
  OrderParameter,
  OutputParameter,
  renameTag,
  type EditSubscriptionBody,
  type GetStreamContentsParams,
  type Item,
} from "./generated/greader.ts";
import { login, refusal, subscriptions, token } from "./api.ts";
import { ServerError, UsageError } from "./errors.ts";
import { unixSeconds } from "./time.ts";

const READING_LIST = "user/-/state/com.google/reading-list";
const READ = "user/-/state/com.google/read";
const STARRED = "user/-/state/com.google/starred";
const LABEL = "user/-/label/";

/** Categories and tags are named by the user and addressed by the server as `user/-/label/<name>`. */
const labelId = (name: string): string => `${LABEL}${name}`;

/** A feed is `feed/<numeric id>`; both `5` and `feed/5` are accepted wherever a feed is named. */
const feedRef = (value: string): string => (value.startsWith("feed/") ? value : `feed/${value}`);

/** stdout carries the JSON result and nothing else, so it can be piped into another program. */
const json = (value: unknown): void => console.log(JSON.stringify(value));

/** A write the server accepted (HTTP 200) is reported in the shape the design fixes. */
const ok = (): void => json({ ok: true });

/** `-` means stdin; anything else is a file the user named. */
const readOpml = async (file: string): Promise<string> => {
  if (file === "-") return await Bun.stdin.text();

  const handle = Bun.file(file);
  if (!(await handle.exists())) throw new UsageError(`no such file: ${file}`);
  return await handle.text();
};

// The server reads at most this much of the request body, so a longer OPML would be cut and refused as malformed.
const MAX_OPML_BYTES = 1_048_576;

const setting = (flag: string | undefined, variable: string, missing: string): string => {
  const value = flag ?? process.env[variable];
  if (value === undefined || value === "") throw new UsageError(missing);
  // The URL is the base without `/api/greader.php`, which http.ts appends.
  return variable === "FRESHRSS_URL" ? value.replace(/\/+$/, "") : value;
};

/** The API password has no flag on purpose: it must never appear in the process list or in shell history. */
const apiPassword = (): string => {
  const value = process.env.FRESHRSS_API_PASSWORD;
  if (value === undefined || value === "") {
    throw new UsageError(
      "no API password: set FRESHRSS_API_PASSWORD (Profile → API management; it is read only from the environment)",
    );
  }
  return value;
};

// Every stream option is validated while commander parses, so a bad argument is reported as a usage error without a
// request ever leaving the process.
type StreamOptions = {
  feed?: string;
  label?: string;
  starred?: boolean;
  stream?: string;
  unread?: boolean;
  read?: boolean;
  count: number;
  oldest?: boolean;
  since?: number;
  until?: number;
  continuation?: string;
  all?: boolean;
};

const addStreamOptions = (command: Command): Command =>
  command
    .addOption(
      new Option("--feed <id>", "a feed, by its numeric id or as feed/<id>")
        .argParser(feedStreamId)
        .conflicts(["label", "starred", "stream"]),
    )
    .addOption(
      new Option("--label <name>", "a category or a tag, by name").conflicts([
        "feed",
        "starred",
        "stream",
      ]),
    )
    .addOption(new Option("--starred", "the starred items").conflicts(["feed", "label", "stream"]))
    .addOption(
      new Option("--stream <id>", "a stream id, as the server gives it").conflicts([
        "feed",
        "label",
        "starred",
      ]),
    )
    .addOption(new Option("--unread", "only the unread items").conflicts(["read"]))
    .addOption(new Option("--read", "only the read items").conflicts(["unread"]))
    .addOption(
      new Option("-n, --count <n>", "items per request (with --all, the page size)")
        .default(20)
        .argParser((value) => {
          const count = Number(value);
          if (!Number.isInteger(count) || count < 1) {
            throw new UsageError(`--count must be a positive whole number, not ${value}`);
          }
          return count;
        }),
    )
    .option("--oldest", "oldest first")
    .addOption(
      new Option(
        "--since <time>",
        "only items published, added or changed at or after this time (ISO 8601 or Unix seconds)",
      ).argParser((value) => unixSeconds(value, "--since")),
    )
    .addOption(
      new Option(
        "--until <time>",
        "only items published and last changed at or before this time (ISO 8601 or Unix seconds)",
      ).argParser((value) => unixSeconds(value, "--until")),
    )
    .option("-c, --continuation <c>", "the continuation of a previous page")
    .option("--all", "follow the continuations to the end of the stream")
    .addHelpText(
      "after",
      "\nWithout --feed, --label, --starred or --stream the whole reading list is read.\n",
    );

/** Commander rejects two selectors at once, so this only has to pick the one that was given. */
const streamId = (options: StreamOptions): string => {
  if (options.feed !== undefined) return feedRef(options.feed);
  if (options.label !== undefined) return labelId(options.label);
  if (options.starred === true) return STARRED;
  return options.stream ?? READING_LIST;
};

const feedStreamId = (value: string): string => {
  const id = feedRef(value);
  if (!/^feed\/\d+$/.test(id)) throw new UsageError(`--feed is a numeric feed id, not ${value}`);
  return id;
};

/** `--starred` already selects the starred stream, so the read state is what `it=` narrows. */
const stateOf = (options: StreamOptions): IncludeTargetParameter | undefined => {
  if (options.unread === true) return IncludeTargetParameter["user/-/state/comgoogle/unread"];
  if (options.read === true) return IncludeTargetParameter["user/-/state/comgoogle/read"];
  return undefined;
};

// stream/contents serves the read and unread states only as a filter on the reading list (stream/items/ids takes them
// either way), so those two stream ids are turned into that filter.
const STATE_STREAMS: Record<string, IncludeTargetParameter> = {
  "user/-/state/com.google/read": IncludeTargetParameter["user/-/state/comgoogle/read"],
  "user/-/state/com.google/unread": IncludeTargetParameter["user/-/state/comgoogle/unread"],
};

const streamParams = (options: StreamOptions, continuation?: string): GetStreamContentsParams => {
  const asked = streamId(options);
  const state = stateOf(options) ?? STATE_STREAMS[asked];
  const next = continuation ?? options.continuation;
  return {
    s: STATE_STREAMS[asked] === undefined ? asked : READING_LIST,
    n: options.count,
    ...(options.oldest === true ? { r: OrderParameter.o } : {}),
    ...(options.since === undefined ? {} : { ot: options.since }),
    ...(options.until === undefined ? {} : { nt: options.until }),
    ...(state === undefined ? {} : { it: state }),
    ...(next === undefined ? {} : { c: next }),
  };
};

type Page<T> = { items: T[]; continuation?: string };

/**
 * One page, or every page when `--all` is given. The continuation of the last page is reported as the server sent it,
 * so a page that came back full and nothing more still tells the caller where to continue.
 */
const collect = async <T>(
  options: StreamOptions,
  fetchPage: (params: GetStreamContentsParams) => Promise<Page<T>>,
): Promise<Page<T>> => {
  const items: T[] = [];
  let continuation = options.continuation;

  for (;;) {
    const page = await fetchPage(streamParams(options, continuation));
    items.push(...page.items);

    const more = page.continuation;
    if (options.all !== true) return more === undefined ? { items } : { items, continuation: more };
    // A continuation that does not move forward would never end.
    if (more === undefined || more === continuation) return { items };
    continuation = more;
  }
};

// Set by `bun build --define` for a release binary; a source checkout reports the package version.
declare const FRESHRSS_BUILD_VERSION: string | undefined;
const version =
  typeof FRESHRSS_BUILD_VERSION === "string"
    ? FRESHRSS_BUILD_VERSION
    : (await import("../package.json")).version;

const program = new Command()
  .name("freshrss")
  .description("Command-line client for FreshRSS over its Google Reader API")
  .option("--url <url>", "server base URL, without /api/greader.php")
  .option("--user <user>", "user name")
  .version(version)
  .showHelpAfterError()
  .exitOverride();

program.hook("preAction", async () => {
  const options = program.opts<{ url?: string; user?: string }>();
  await login({
    url: setting(options.url, "FRESHRSS_URL", "no server URL: pass --url or set FRESHRSS_URL"),
    user: setting(options.user, "FRESHRSS_USER", "no user name: pass --user or set FRESHRSS_USER"),
    password: apiPassword(),
  });
});

program
  .command("user")
  .description("the authenticated user")
  .action(async () => {
    const res = await getUserInfo();
    if (res.status !== 200) refusal(res);
    json(res.data);
  });

const subs = program.command("subs").description("subscriptions");

subs
  .command("list")
  .description("every subscription")
  .action(async () => {
    json(await subscriptions());
  });

subs
  .command("add <url>")
  .description("subscribe to a feed")
  .option("--title <title>", "title for the subscription")
  .option("--category <name>", "category to file the feed in")
  .action(async (url: string, options: { title?: string; category?: string }) => {
    const body: EditSubscriptionBody = {
      s: [feedRef(url)],
      ac: EditSubscriptionBodyAc.subscribe,
      ...(options.title === undefined ? {} : { t: [options.title] }),
      ...(options.category === undefined ? {} : { a: labelId(options.category) }),
    };

    // The server answers only `OK` and may store another URL than the one given (a discovered feed, a redirect,
    // https added), so the new subscription is the one that was not listed before.
    const before = new Set((await subscriptions()).map((sub) => sub.id));
    const res = await editSubscription(body);
    if (res.status !== 200) refusal(res);

    const added = (await subscriptions()).find((sub) => !before.has(sub.id));
    if (added === undefined) {
      throw new ServerError(`the server answered OK but lists no new subscription for ${url}`);
    }
    json(added);
  });

subs
  .command("edit <feed>")
  .description("rename a subscription and move it to another category")
  .option("--title <title>", "new title")
  .option("--category <name>", "category to move the feed to")
  .action(async (feed: string, options: { title?: string; category?: string }) => {
    if (options.title === undefined && options.category === undefined) {
      throw new UsageError("subs edit needs --title, --category or both");
    }
    const body: EditSubscriptionBody = {
      s: [feedRef(feed)],
      ac: EditSubscriptionBodyAc.edit,
      ...(options.title === undefined ? {} : { t: [options.title] }),
      ...(options.category === undefined ? {} : { a: labelId(options.category) }),
    };

    const res = await editSubscription(body);
    if (res.status !== 200) refusal(res);
    ok();
  });

subs
  .command("rm <feed...>")
  .description("unsubscribe from one or more feeds")
  .action(async (feeds: string[]) => {
    const res = await editSubscription({
      s: feeds.map(feedRef),
      ac: EditSubscriptionBodyAc.unsubscribe,
    });
    if (res.status !== 200) refusal(res);
    ok();
  });

subs
  .command("export")
  .description("every subscription as OPML on stdout")
  .action(async () => {
    const res = await exportSubscriptions();
    if (res.status !== 200) refusal(res);
    await Bun.write(Bun.stdout, res.data);
  });

subs
  .command("import <file>")
  .description("import subscriptions from an OPML file, or from stdin with -")
  .action(async (file: string) => {
    const opml = await readOpml(file);
    const size = new TextEncoder().encode(opml).length;
    if (size > MAX_OPML_BYTES) {
      throw new UsageError(
        `the server reads at most ${MAX_OPML_BYTES} bytes of OPML; this is ${size}`,
      );
    }
    const res = await importSubscriptions(opml);
    if (res.status !== 200) refusal(res);
    ok();
  });

const tags = program.command("tags").description("categories and tags");

tags
  .command("list")
  .description("every category and tag")
  .action(async () => {
    const res = await listTags({ output: OutputParameter.json });
    if (res.status !== 200) refusal(res);
    json(res.data.tags);
  });

tags
  .command("rename <old> <new>")
  .description("rename a category or a tag")
  .action(async (oldName: string, newName: string) => {
    const res = await renameTag({ T: await token(), s: labelId(oldName), dest: labelId(newName) });
    if (res.status !== 200) refusal(res);
    ok();
  });

tags
  .command("rm <name>")
  .description("delete a category or a tag")
  .action(async (name: string) => {
    const res = await disableTag({ T: await token(), s: labelId(name) });
    if (res.status !== 200) refusal(res);
    ok();
  });

program
  .command("unread")
  .description("unread counts per feed, category, tag and in total")
  .action(async () => {
    const res = await getUnreadCount({ output: OutputParameter.json });
    if (res.status !== 200) refusal(res);
    json(res.data);
  });

addStreamOptions(
  program.command("entries").description("items of one stream, with their content"),
).action(async (options: StreamOptions) => {
  const page = await collect<Item>(options, async (params) => {
    const res = await getStreamContents(params);
    if (res.status !== 200) refusal(res);
    return res.data;
  });
  json(page);
});

addStreamOptions(program.command("ids").description("the ids of the items of one stream")).action(
  async (options: StreamOptions) => {
    const page = await collect<string>(options, async (params) => {
      const res = await getStreamItemIds(params);
      if (res.status !== 200) refusal(res);
      const { itemRefs, continuation } = res.data;
      return {
        items: itemRefs.map((ref) => ref.id),
        ...(continuation === undefined ? {} : { continuation }),
      };
    });
    json({
      ids: page.items,
      ...(page.continuation === undefined ? {} : { continuation: page.continuation }),
    });
  },
);

program
  .command("get <item...>")
  .description("fetch items by id, in either id form")
  .action(async (ids: string[]) => {
    const res = await getStreamItemContents({ i: ids });
    if (res.status !== 200) refusal(res);
    json({ items: res.data.items });
  });

program
  .command("mark")
  .description("mark items read, unread, starred or unstarred, or tag and untag them")
  .argument("<action>", "read, unread, star, unstar, tag or untag")
  .argument("[item...]", "item ids; `tag` and `untag` take the tag name first")
  .addHelpText(
    "after",
    "\nExamples:\n  $ freshrss mark read 42\n  $ freshrss mark star tag:google.com,2005:reader/item/0123456789abcdef\n  $ freshrss mark tag Later 42 43\n  $ freshrss mark untag Later 42\n",
  )
  .action(async (action: string, args: string[]) => {
    let add: string[] | undefined = undefined;
    let remove: string[] | undefined = undefined;
    let ids = args;

    switch (action) {
      case "read":
        add = [READ];
        break;
      case "unread":
        remove = [READ];
        break;
      case "star":
        add = [STARRED];
        break;
      case "unstar":
        remove = [STARRED];
        break;
      case "tag":
      case "untag": {
        const [name, ...rest] = args;
        if (name === undefined)
          throw new UsageError(`mark ${action} needs a tag name and at least one item id`);
        if (action === "tag") add = [labelId(name)];
        else remove = [labelId(name)];
        ids = rest;
        break;
      }
      default:
        throw new UsageError(
          `unknown mark action: ${action} (read, unread, star, unstar, tag, untag)`,
        );
    }

    if (ids.length === 0) throw new UsageError(`mark ${action} needs at least one item id`);

    const res = await editTag({
      T: await token(),
      i: ids,
      ...(add === undefined ? {} : { a: add }),
      ...(remove === undefined ? {} : { r: remove }),
    });
    if (res.status !== 200) refusal(res);
    ok();
  });

program
  .command("mark-all-read <stream>")
  .description("mark every item of a stream read")
  .addOption(
    new Option(
      "--before <time>",
      "only items FreshRSS added before this time (ISO 8601 or Unix seconds)",
    ).argParser((value) => {
      const seconds = unixSeconds(value, "--before");
      // ts=0 means "no bound" to the server, so a time at or before 1970 would mark the whole stream read.
      if (seconds <= 0) throw new UsageError(`--before must be after 1970-01-01, not ${value}`);
      return seconds;
    }),
  )
  .action(async (stream: string, options: { before?: number }) => {
    const body: Parameters<typeof markAllAsRead>[0] = { T: await token(), s: stream };
    if (options.before !== undefined) {
      // The server compares `ts` with item ids, which are the microsecond time FreshRSS added each item (its source
      // comment says nanoseconds; EntryDAO compares `id <= ts`).
      body.ts = (BigInt(options.before) * 1_000_000n).toString();
    }

    const res = await markAllAsRead(body);
    if (res.status !== 200) refusal(res);
    ok();
  });

const main = async (): Promise<void> => {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version are not failures; every other commander error is a usage error.
      process.exitCode = error.exitCode === 0 ? 0 : 2;
      return;
    }
    process.exitCode = error instanceof UsageError ? 2 : 1;
    console.error(`freshrss: ${error instanceof Error ? error.message : String(error)}`);
  }
};

await main();
