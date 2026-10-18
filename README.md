# freshrss-cli

Command-line client for [FreshRSS](https://github.com/FreshRSS/FreshRSS), the self-hostable feed reader, over its Google Reader API.

It manages subscriptions, categories and tags, reads items, and marks them read, unread, starred or tagged — from any machine that can reach the server, without shell access to it. Every command prints JSON on stdout (OPML for `subs export`) and keeps logs and errors on stderr, so a script or a coding agent reads exactly what a person types (see [Output](#output)).

A single self-contained binary, no runtime to install. Ships for `linux/amd64`, `linux/arm64`, `darwin/amd64` and `darwin/arm64`.

## Status

Pre-release (`v0.1.0-rc.N`). Every push to `main` that passes CI is released, so the latest release is always what is on `main`. The command surface below is complete for what the API offers; flags may still change before `v0.1.0`.

## Install

```bash
curl -fsSL https://github.com/TakashiAihara/freshrss-cli/releases/latest/download/install.sh | sh
```

Installs the latest release into `$HOME/.local/bin`, and tells you if that is not on your `PATH`. `wget` works in place of `curl`.

The script:

- checks the archive against the release's `checksums.txt`, and refuses to install if it does not match or no sha256 tool is present
- stages the new binary beside the old one, runs it, and only then moves it into place — a bad download leaves the copy you already had

| variable                   | effect                                               |
| -------------------------- | ---------------------------------------------------- |
| `FRESHRSS_INSTALL_VERSION` | install a specific tag instead of the latest release |
| `FRESHRSS_INSTALL_DIR`     | install somewhere other than `$HOME/.local/bin`      |
| `FRESHRSS_RELEASE_BASE`    | fetch archives from a mirror                         |

Every published file, `install.sh` included, carries a GitHub build provenance attestation. To check an archive taken from the [releases page](https://github.com/TakashiAihara/freshrss-cli/releases):

```bash
gh attestation verify freshrss_linux_amd64.tar.gz --repo TakashiAihara/freshrss-cli
```

From a clone, with Bun: `bun install && bun run install-bin` links `src/cli.ts` into `~/.local/bin` (`FRESHRSS_BIN_DIR` changes where).

## Configure

On the server, enable the API (Administration → Authentication → "Allow API access") and set an API password for your user (Profile → API management). The API password is not the web login password.

| value                                        | flag     | environment             |
| -------------------------------------------- | -------- | ----------------------- |
| server base URL (without `/api/greader.php`) | `--url`  | `FRESHRSS_URL`          |
| user name                                    | `--user` | `FRESHRSS_USER`         |
| API password                                 | none     | `FRESHRSS_API_PASSWORD` |

```bash
export FRESHRSS_URL=https://freshrss.example.net
export FRESHRSS_USER=alice
export FRESHRSS_API_PASSWORD=...
```

- Flags go before the command: `freshrss --url ... subs list`.
- The API password is read only from the environment, so it never shows up in the process list or shell history.
- Each run logs in afresh. Nothing is cached on disk.

## Use

```bash
freshrss subs list
freshrss subs add https://example.net/feed.xml --category News
freshrss entries --unread -n 50
freshrss entries --label News --since 2026-10-01 --all
freshrss mark read 'tag:google.com,2005:reader/item/0006421a5b8f3c20'
freshrss mark-all-read --label News
freshrss subs export > subscriptions.opml
```

| area          | commands                                                              |
| ------------- | --------------------------------------------------------------------- |
| account       | `user`, `unread`                                                      |
| subscriptions | `subs list`, `subs add`, `subs edit`, `subs rm`                       |
| OPML          | `subs export`, `subs import`                                          |
| tags          | `tags list`, `tags rename`, `tags rm`                                 |
| items         | `entries`, `ids`, `get`                                               |
| state         | `mark read\|unread\|star\|unstar`, `mark tag\|untag`, `mark-all-read` |

`entries` and `ids` select a stream with one of `--feed`, `--label`, `--starred` or `--stream` (the whole reading list when none is given), filter with `--unread` / `--read` and `--since` / `--until`, and page with `-n`, `-c` or `--all`.

Every command, option and output shape is listed in [docs/design.md](docs/design.md).

## Output

Output is the same whether stdout is a terminal or a pipe: JSON, one document per run.

```bash
# titles of today's unread items
freshrss entries --unread --since "$(date -u +%F)" --all | jq -r '.items[].title'

# star everything unread in one feed
freshrss ids --feed 12 --unread --all | jq -r '.ids[]' | xargs -r freshrss mark star
```

| exit code | meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| 0         | success                                                                         |
| 1         | the server refused or failed; its message is on stderr                          |
| 2         | usage or configuration error (missing URL / user / API password, bad arguments) |

Writes are checked: a write the server does not answer with `OK` exits 1, and `subs rm` with several feeds names which were removed, which failed and which were not attempted.

## Why the API and not FreshRSS's `cli/*.php`

- `cli/*.php` runs inside the server or its container and needs a shell there. The API works from anywhere with a URL and an API password.
- The API covers subscriptions, categories, tags, items and read / starred state, which is what a reader needs day to day.

## What the API cannot do

- Create or change XPath / JSON scraping feeds' settings. Make them in the web UI; `subs export` / `subs import` carry them as OPML.
- Manage users or server settings.

## Development

```bash
bun install
bunx lefthook install   # format, lint and typecheck before each commit
bun test                # starts a throwaway FreshRSS in Docker
bun run typecheck
bun run lint
```

- The HTTP client in `src/generated/` is generated by Orval from `openapi/greader.yaml`. FreshRSS publishes no OpenAPI document, so that file is written by hand from FreshRSS's `p/api/greader.php`. Regenerate with `bun run generate`; CI fails if the generated client and the document disagree.
- The tests run the CLI as a subprocess against a real FreshRSS (`freshrss/freshrss:1.30.0`) and a local feed server, and read the server state back after every write. No test touches a real instance.

## License

[MIT](LICENSE)
