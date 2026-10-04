# AGENTS.md

Rules for coding agents in this repository.

- What to build is in `docs/design.md`. The HTTP API is `openapi/greader.yaml`; its client is generated into `src/generated/` by `bun run generate`.
- Do not edit `openapi/`, `src/generated/`, `src/http.ts`, `test/`, `docs/`, `AGENTS.md`. If one of them is wrong, stop and report what and why.
- Do not edit a test to make it pass.
- Do not add dependencies.
- Never use `any`, `!` (non-null assertion), `@ts-ignore`, `@ts-expect-error`.
- Call the API only through the generated functions in `src/generated/greader.ts`.
- Done means `bun test`, `bun run typecheck` and `bun run lint` all exit 0. Paste the last lines of each.
