# Migrating Dome API SDK Generation to **Fern**

> **Audience:** Dome backend & CLI maintainers
> **Goal:** Replace the current `openapi-typescript-codegen` flow with [Fern](https://buildwithfern.com) so that SDKs and docs are generated, versioned, and published automatically.

---

## 1. Why Fern?

| Need                              | How Fern Helps                                                      |
| --------------------------------- | ------------------------------------------------------------------- |
| Multi‑language SDKs & hosted docs | Generates TS, Python, Go, etc. and branded docs from the same spec  |
| Opinionated project layout        | `fern/` folder keeps spec, generators, and CLI version in one place |
| GitHub‑first workflow             | CLI + GH Actions publish PRs/releases automatically                 |
| SaaS add‑ons                      | Optional hosted docs, analytics, diff PRs, npm/maven/pip publishing |

## 2. Prerequisites

- **Node ≥ 18** (for native `fetch`)
- `openapi.json` created by `pnpm run gen:openapi` (already in repo)
- **npm token** with publish rights (if publishing to npm)
- **GitHub PAT** with `packages:write` (optional for GHCR)

## 3. Project Bootstrapping

```bash
# 1. Add the CLI
pnpm add -D fern-api/fern@latest   # locked to a version in package.json

# 2. Scaffold the fern folder
npx fern init                      # creates ./fern
```

Folder structure:

```
fern/
│ fern.config.json        # org + generators
│ openapi.yml             # copy of openapi.json (symlink or CI‑synced)
└─ generators.json        # which SDKs/docs to emit
```

### 3.1 Syncing the OpenAPI file

We already maintain `openapi.json` at repo root. Use the **sync‑openapi** GH Action to copy it into `fern/openapi.json` every PR:

```yaml
- uses: fern-api/sync-openapi@v0
  with:
    openapi-file: openapi.json
    fern-folder: fern
```

## 4. Configure Generators

`fern/generators.json`

```json
{
  "groups": {
    "sdk": {
      "generator": {
        "name": "typescript",
        "version": "latest",
        "config": {
          "output": "sdks/typescript",
          "packageName": "@dome/api",
          "client": "fetch",
          "mode": "unified"
        }
      },
      "github": {
        "repository": "dome-inc/dome-sdk",
        "publishInfo": {
          "registry": "npm",
          "tokenEnv": "NPM_TOKEN"
        }
      }
    }
  }
}
```

- **client**: `fetch` → works in both Node 18 and browsers/Cloudflare.
- **mode** `unified`: single package; use `subpackages` if we split services later.

## 5. Local Dev Loop

```bash
# Lint the spec
npx fern check

# Generate the SDK + docs (locally)
FERN_TOKEN=local npx fern generate --group sdk
```

Add to `package.json`:

```json
"scripts": {
  "gen:sdk": "fern generate --group sdk --log-level info"
}
```

## 6. CI / CD

`.github/workflows/sdk.yml`

```yaml
name: Generate & Publish SDK
on:
  push:
    branches: [main]
    paths: [openapi.json, 'src/**', 'fern/**']

jobs:
  sdk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - run: pnpm i
      - name: Sync OpenAPI into fern/
        uses: fern-api/sync-openapi@v0
        with:
          openapi-file: openapi.json
          fern-folder: fern
      - run: pnpm run gen:openapi # keep spec fresh
      - run: pnpm run gen:sdk
        env:
          FERN_TOKEN: ${{ secrets.FERN_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- `FERN_TOKEN` only needed for hosted docs or Pro features.

## 7. Migrating the CLI Code

### Old (openapi-typescript-codegen)

```ts
import { NotesService } from '@dome/api';
const notes = await NotesService.listNotes({ limit: 50 }, { BASE: baseUrl, TOKEN: () => jwt });
```

### New (Fern‑generated)

```ts
import { DomeApi } from '@dome/api';
const client = new DomeApi({ baseURL: baseUrl, token: jwt });
const notes = await client.notes.list({ limit: 50 });
```

- **Top‑level client** instead of per‑service functions.
- Options (base URL, auth) are passed once in the constructor.
- Errors become typed subclasses (`UnauthorizedError`, `NotFoundError`).

#### Auth helper

Add a tiny wrapper so the CLI keeps using the existing token storage:

```ts
export const domeClient = () =>
  new DomeApi({
    baseURL: process.env.DOME_API ?? 'https://api.dome.com',
    token: () => process.env.DOME_TOKEN ?? '',
  });
```

## 8. Versioning Strategy

- **SDK version** = SemVer following API changes (`v0.2.0` when a new endpoint ships).
- Tag releases and let Fern bump & publish via GitHub Release → Action.
- Keep `openapi.json` in PR diff so breaking changes surface in code reviews.

## 9. Known Gotchas

| Issue                               | Fix                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------- |
| ESM‑only output                     | If scripts run under `ts-node`, enable `moduleResolution: node16`       |
| Cloudflare Workers `fetch` polyfill | None needed — Workers have WHATWG `fetch` built‑in                      |
| Upload / form‑data endpoints        | Fern generates helpers; pass `ReadableStream`/`Blob`                    |
| Pagination helper                   | Fern recognises `next_cursor` style; otherwise implement custom wrapper |

## 10. Resources

- Fern quick‑start: [https://buildwithfern.com/learn/sdks/guides/generate-your-first-sdk](https://buildwithfern.com/learn/sdks/guides/generate-your-first-sdk)
- sync‑openapi Action: [https://github.com/fern-api/sync-openapi](https://github.com/fern-api/sync-openapi)
- Sample TypeScript SDK repo: [https://github.com/fern-api/sdk-starter](https://github.com/fern-api/sdk-starter)

---

**Contacts:** @Mark Toda, @Dev Tools Guild
