# ocsearchv2 — semantic OpenCode session search

> **HISTORICAL (JSON-era POC).** Production: **`sessions/*.md` on `main`**, `~/codes/ocsearchv2/README.md`, skill `$OcSearchV2`, `docs/PITFALLS.md`. Do not use JSON/`path: ["sessions/**"]` guidance below as source of truth.

**Goal:** Replace slow local `ocsearch` (`LIKE` on 11GB SQLite) with **Copilot embeddings** via `githubrepo` on private `lkonga/ocsearchv2`, then **local drill-down** (`ocsearch --export` / `--parts`).

**Repo:** `lkonga/ocsearchv2` (private) — create manually if missing:
```bash
gh repo create lkonga/ocsearchv2 --private --clone=false \
  --description "OpenCode session index for semantic search (githubrepo)"
```

---

## Executive summary

| Approach | Verdict |
|----------|---------|
| Push full `opencode.db` | **Reject** — fork DB **~11GB**, 23k+ sessions; GitHub size limits, no practical Copilot index, secrets in `credential` / message JSON |
| Push trimmed SQLite (last 500 sessions) | **Possible** but awkward — still binary, harder to diff/review, indexing uncertain |
| **JSON export (last N sessions, default 500)** | **Recommended** — small repo, git-friendly deltas, text embeds well; mirrors Obsidian “many JSON/markdown files” model |
| Hybrid | **Best practice** — `manifest.json` + `sessions/<ses_id>.json` (metadata + searchable excerpt) + optional `summaries/<ses_id>.md`; full bodies stay local until export |

---

## Why ocsearch is slow today

- DB: `~/.local/share/opencode-fork/opencode/opencode.db` (**11G**), **~1.89M** `part` rows.
- `ocsearch -c` joins `session` + `part` with `LIKE '%…%'` — full table scans.
- Skill: `$SessionSearch` / `~/.local/bin/ocsearch` — correct for drill-down, wrong for discovery at scale.

## githubrepo tool (reference)

- Plugin: `opencode-githubrepo` — semantic search via **GitHub Copilot embeddings API** (`api.github.com`).
- Needs **github-copilot** OAuth + usually **`gh`** with `repo` for **private** repos (`GITHUBREPO_PREFER_GH=1`).
- Returns ranked snippets: **path, lines, similarity** — ideal for “which session mentioned X?”
- **POC in this harness:** searches returned `404 repository not found` (token/indexing) — **re-run POC in your OpenCode session** with working Copilot + `gh auth refresh -s repo`.

### Obsidian POC (proof JSON-at-scale works)

Target repos: `lkonga/obsidian-vaults`, `lkonga/semantic-iss…` (vault-related).

```text
githubrepo(repo="lkonga/obsidian-vaults", query="daily note journal")
githubrepo(repo="lkonga/obsidian-vaults", query="project task frontmatter", path=["**/*.md"])
```

If these return file paths + snippets, **ocsearchv2 JSON layout will work the same way**.

---

## Recommended sync design (`ocsearch-sync`)

**On-demand runner** (later: scheduled — separate ticket).

### Inputs

- `OPENCODE_DB` default: `~/.local/share/opencode-fork/opencode/opencode.db`
- `--limit 500` (main sessions only, `parent_id IS NULL`, order `time_created DESC`)
- `--since <manifest.synced_at>` for deltas (optional phase 2)

### Outputs (git push to `ocsearchv2`)

```text
manifest.json          # synced_at, db_sha?, session_count, session_ids[]
sessions/ses_xxx.json  # id, title, directory, project_id, times, excerpt (~8–32KB searchable text)
README.md              # no secrets; describes layout
.gitignore             # exclude local-only artifacts
```

### Per-session JSON (searchable fields)

- `title`, `directory`, `agent`/`model` from first messages
- `excerpt`: concatenation of user + assistant **text** parts (truncated), not full tool blobs
- `tags` optional later

**Do not sync:** `credential`, raw tool outputs with env secrets, full 11GB history.

### Delta strategy

1. Read `manifest.json` from repo (or local cache).
2. Select sessions with `time_created > last_sync` OR not in manifest (cap batch size).
3. Write new/updated `sessions/*.json`, update manifest.
4. `git commit` + `push` (runner script or CI on demand).

### Size guard (before push)

- If total export **> 500MB** → warn user; reduce `--limit` or excerpt length.
- If user insists on DB: export **only** tables `session`, `message`, `part` for last 500 session IDs into `ocsearchv2.db` via `sqlite3 .backup` / attach — still second choice vs JSON.

---

## ocsearchv2 skill (new)

**Name:** `ocsearchv2` (or extend `session-search` with v2 path)

**Workflow:**

1. **Discover:** `githubrepo(repo="lkonga/ocsearchv2", query="<user intent>", path=["sessions/**"])`  
2. **Parse hits:** extract `ses_…` from paths like `sessions/ses_xxx.json`.  
3. **Deep read (local):** `ocsearch --export ses_xxx` or `--parts` / `--summary` on fork DB.  
4. **Fallback:** if githubrepo fails → `ocsearch -t/-c` with `-l` and `-d`.

**Triggers:** `ocsearchv2`, `semantic session search`, `find session about`.

---

## Subtasks (implementation order)

### ST-1 — Repo bootstrap
- [ ] Create `lkonga/ocsearchv2` (private)
- [ ] Add README (layout, privacy: excerpts only)
- [ ] Initial empty `manifest.json`

### ST-2 — `ocsearch-sync` CLI
- [ ] Bash or Bun script in `ocsearchv2` repo or `opencode-githubrepo` sibling
- [ ] SQL: last N main sessions + excerpt builder from `part` (`type=text`)
- [ ] Redaction pass (API keys, tokens regex)
- [ ] `--dry-run` + size estimate
- [ ] `git push` helper (requires `gh` auth)

### ST-3 — Verify embeddings POC
- [ ] User-run: `githubrepo` on `obsidian-vaults` and on `ocsearchv2` after first sync
- [ ] Document required auth (`GITHUBREPO_PREFER_GH=1`)
- [ ] Record latency + hit quality in README

### ST-4 — Skill `ocsearchv2`
- [ ] `$OPENCODE_CONFIG_DIR/skills/ocsearchv2/SKILL.md`
- [ ] Link to sync runner + manifest contract
- [ ] Deprecate heavy `-c` guidance in favor of v2-first

### ST-5 — Scheduled sync (future)
- [ ] systemd timer or cron on i7mech
- [ ] Issue: smart schedule (only if manifest stale >24h or session count delta)

### ST-6 — Optional enhancements
- [ ] Shadow index: `index/sessions.ndjson` single file for smaller clone
- [ ] FTS local cache keyed by manifest session list
- [ ] Multi-machine: one canonical DB path via `OPENCODE_DB`

---

## GitHub issue (paste into `lkonga/ocsearchv2`)

**Title:** Epic: ocsearchv2 sync + semantic session search

**Body:**

```markdown
## Problem
Local `ocsearch` content search is too slow on ~11GB SQLite (~24k sessions).

## Solution
1. On-demand sync: last 500 main sessions → `sessions/*.json` + `manifest.json`
2. Private repo indexed by Copilot embeddings
3. New skill: query via `githubrepo` → local `ocsearch --export`

## Acceptance criteria
- [ ] Repo created; no full DB committed
- [ ] Sync runner with size warning (>500MB)
- [ ] POC: githubrepo returns session file paths for a known query
- [ ] ocsearchv2 skill documented in opencode-stable skills

## Non-goals (v1)
- Full history sync
- Scheduled sync (follow-up issue)

## Risks
- Copilot may lag indexing new private repo
- Secrets in excerpts → redaction required
- 404 search → fix gh/copilot auth (see opencode-githubrepo README)
```

Create issue:
```bash
gh issue create -R lkonga/ocsearchv2 \
  --title "Epic: ocsearchv2 sync + semantic session search" \
  --body-file /path/to/this/tasks/ocsearchv2-semantic-session-search.md
```

---

## Fanout capture notes

- **Topology:** 1×2 (manager skipped — parent wrote deliverable); 2× `@glm52umans` workers dispatched for sync + githubrepo deep dives (merge when complete).
- **Deliverable:** `tasks/ocsearchv2-semantic-session-search.md` (this file).

---

## Parent recommendation (one line)

**Do not upload the DB** — use **JSON last-500 + manifest deltas** into `ocsearchv2`, **githubrepo for discovery**, **ocsearch for full session**; confirm with **obsidian-vaults** POC once Copilot/gh auth works in your environment.