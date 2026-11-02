// v2/semantic-index-v2.test.mjs — deterministic regression tests for V2 index
// status / trigger / poll semantics (parity with host index.ts @ e9a7507).
// Fully offline: fake tokens, fake fetch, injected sleep — no credential reads,
// no `gh`, no timers. Run: bun test v2/semantic-index-v2.test.mjs

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { checkIndex, ensureShadow, executeSearch, sanitizeUpstreamBody, waitForIndex } = await import("./core.mjs")

const AMBIENT = { ghOnly: process.env.GITHUBREPO_GH_ONLY, branchSearch: process.env.GITHUBREPO_BRANCH_SEARCH }
const restore = (key, value) => (value === undefined ? delete process.env[key] : (process.env[key] = value))
// Wrapper hosts export GITHUBREPO_GH_ONLY=1 / GITHUBREPO_BRANCH_SEARCH=true, which
// disable the OAuth-primary + scope-404-fallback paths under test. Scope the
// override to this file and restore ambient values afterwards.
beforeAll(() => {
  delete process.env.GITHUBREPO_GH_ONLY
  delete process.env.GITHUBREPO_BRANCH_SEARCH
})
afterAll(() => {
  restore("GITHUBREPO_GH_ONLY", AMBIENT.ghOnly)
  restore("GITHUBREPO_BRANCH_SEARCH", AMBIENT.branchSearch)
})

const OAUTH = "fake-oauth-token"
const GH = "fake-gh-token"
const SIGNAL = new AbortController().signal
const INDEX = "/copilot_internal/embeddings_index"
const SEARCH = "/embeddings/code/search"
const RESULT = {
  chunk: { text: "code()", line_range: { start: 1, end: 2 } },
  distance: 0.25,
  location: { path: "src/a.ts", ref_name: "refs/heads/main", commit_sha: "sha" },
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const LEAKY_JSON = '{"token":"supersecretvalue","authorization":"Bearer ghp_FAKEFAKEFAKEFAKEFAKEFAKE"}'
const BODY_404 = 'repository not found for "protected_org_ids" {"oauth_token":"supersecretvalue"}'

function fakeFetch(handler) {
  const calls = []
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", body: init.body, auth: init.headers?.Authorization }
    calls.push(call)
    return handler(call)
  }
  fn.calls = calls
  fn.index = () => calls.filter((c) => c.url.endsWith(INDEX))
  fn.search = () => calls.filter((c) => c.url.endsWith(SEARCH))
  return fn
}

const deps = (fetch, extra = {}) => ({
  token: OAUTH,
  tokens: { copilotOauth: OAUTH, gh: GH },
  fetch,
  sleep: async () => {},
  ...extra,
})
const hits = (results = [RESULT]) => json({ results })

describe("checkIndex current semantic fields", () => {
  const at = (body, status = 200) => ({ fetch: fakeFetch(() => json(body, status)) })

  test("semantic fields decide ready/building/not-indexed; 404 is ready; other non-ok is error", async () => {
    expect(await checkIndex("o", "r", "t", SIGNAL, at({ semantic_code_search_ok: true, semantic_commit_sha: "abc" })))
      .toEqual({ state: "ready", sha: "abc" })
    expect(await checkIndex("o", "r", "t", SIGNAL, at({ semantic_indexing_enabled: true }))).toEqual({ state: "building" })
    expect(await checkIndex("o", "r", "t", SIGNAL, at({}))).toEqual({ state: "not-indexed" })
    // Obsolete clusters/status/sha shape must not be treated as ready.
    expect(await checkIndex("o", "r", "t", SIGNAL, at({ clusters: [{ id: 1 }], status: "building", sha: "old" })))
      .toEqual({ state: "not-indexed" })
    expect(await checkIndex("o", "r", "t", SIGNAL, at({ message: "Not Found" }, 404))).toEqual({ state: "ready" })
    for (const status of [403, 500]) {
      expect(await checkIndex("o", "r", "t", SIGNAL, at({ message: "nope" }, status))).toEqual({ state: "error" })
    }
  })
})

describe("executeSearch index flow", () => {
  test("index-status 404 goes straight to direct embeddings search (no trigger)", async () => {
    const fetch = fakeFetch((c) => (c.url.endsWith(INDEX) ? json({ message: "Not Found" }, 404) : hits()))
    const out = await executeSearch({ repo: "owner/repo", query: "code" }, deps(fetch))
    expect(out.text).toContain("src/a.ts")
    expect(fetch.index().map((c) => c.method)).toEqual(["GET"])
    expect(fetch.search().length).toBe(1)
    expect(fetch.search()[0].auth).toBe(`Bearer ${OAUTH}`)
  })

  test("not-indexed -> trigger accepted -> building -> ready, with {auto:false} body", async () => {
    let gets = 0
    const fetch = fakeFetch((c) => {
      if (!c.url.endsWith(INDEX)) return hits()
      if (c.method === "POST") return json({})
      gets += 1
      if (gets === 1) return json({})
      if (gets === 2) return json({ semantic_indexing_enabled: true })
      return json({ semantic_code_search_ok: true, semantic_commit_sha: "sha1" })
    })
    const out = await executeSearch({ repo: "owner/repo", query: "code" }, deps(fetch))
    expect(out.text).toContain("src/a.ts")
    expect(gets).toBe(3) // initial not-indexed, one building poll, one ready poll
    const trigger = fetch.index().filter((c) => c.method === "POST")
    expect(trigger.length).toBe(1)
    expect(trigger[0].body).toBe(JSON.stringify({ auto: false }))
  })

  test("polling is bounded: exactly `attempts` checks, no unbounded extra probe", async () => {
    let checks = 0
    const io = { sleep: async () => {}, check: async () => (checks += 1, { state: "building" }) }
    expect(await waitForIndex("owner", "repo", OAUTH, SIGNAL, 3, io)).toEqual({ state: "building" })
    expect(checks).toBe(3)

    process.env.GITHUBREPO_POLL_ATTEMPTS = "3"
    try {
      const fetch = fakeFetch(() => json({ semantic_indexing_enabled: true }))
      await expect(executeSearch({ repo: "owner/repo", query: "code" }, deps(fetch))).rejects.toThrow(
        /not ready after polling/
      )
      expect(fetch.calls.length).toBe(4) // 1 initial status + 3 bounded polls, no 5th probe
    } finally {
      delete process.env.GITHUBREPO_POLL_ATTEMPTS
    }
  })

  test("OAuth scope-404 retries the actual embeddings request with gh", async () => {
    const fetch = fakeFetch((c) => {
      if (c.url.endsWith(INDEX)) return json({ message: "Not Found" }, 404)
      if (c.auth === `Bearer ${OAUTH}`) return json({ message: 'repository not found for "protected_org_ids"' }, 404)
      return hits()
    })
    const out = await executeSearch({ repo: "me/private-repo", query: "code" }, deps(fetch))
    expect(out.text).toContain("src/a.ts")
    expect(fetch.search().map((c) => c.auth)).toEqual([`Bearer ${OAUTH}`, `Bearer ${GH}`])
    expect(fetch.index().length).toBe(1) // no extra index probe between attempts
  })
})

describe("branch shadow routing", () => {
  test("no branch => no shadow/self-user endpoint is touched", async () => {
    const fetch = fakeFetch((c) => (c.url.endsWith(INDEX) ? json({ message: "Not Found" }, 404) : hits()))
    const noAuth = (what) => Promise.reject(new Error(`${what} must not run without a branch`))
    const out = await executeSearch({ repo: "owner/repo", query: "code" }, deps(fetch, {
      getAuthUser: () => noAuth("getAuthUser"),
      ensureShadow: () => noAuth("ensureShadow"),
    }))
    expect(out.text).toContain("src/a.ts")
    const urls = fetch.calls.map((c) => c.url).join(" ")
    for (const forbidden of ["/user", "/forks", "/import", "tmp-ghrtool"]) expect(urls).not.toContain(forbidden)
  })

  test("explicit non-default branch uses (mocked) shadow orchestration", async () => {
    const shadowCalls = []
    const sha = "a".repeat(40)
    const fetch = fakeFetch((c) => (c.url.endsWith(INDEX) ? json({ semantic_code_search_ok: true, semantic_commit_sha: sha }) : hits([{ ...RESULT, location: { ...RESULT.location, commit_sha: sha } }])))
    const out = await executeSearch({ repo: "owner/repo", query: "code", branch: "feature/x" }, deps(fetch, {
      getAuthUser: async () => "me",
      ensureShadow: async (login, owner, repo, branch) => {
        shadowCalls.push({ login, owner, repo, branch })
        return { shadowOwner: login, shadowRepo: `tmp-ghrtool-${repo}-feature-x`, sourceSha: sha }
      },
    }))
    expect(shadowCalls).toEqual([{ login: "me", owner: "owner", repo: "repo", branch: "feature/x" }])
    expect(out.text).toContain("src/a.ts")
    expect(fetch.search().length).toBe(1)
    expect(JSON.parse(fetch.search()[0].body).scoping_query).toBe("repo:me/tmp-ghrtool-repo-feature-x")
    for (const c of fetch.calls) expect(c.method).not.toBe("DELETE")
  })
})

describe("managed shadow safety", () => {
  const sha = "a".repeat(40)
  test("rejects path traversal before any network request", async () => {
    const fetch = fakeFetch(() => { throw new Error('unexpected request') })
    await expect(ensureShadow('me', '..', 'repo', 'feature', OAUTH, SIGNAL, () => {}, { fetch })).rejects.toThrow('Invalid repository')
    expect(fetch.calls).toHaveLength(0)
  })
  test("rejects private sources and collisions without mutations", async () => {
    for (const mode of ["private", "collision", "forbidden"]) {
      const fetch = fakeFetch(c => {
        if (c.url.endsWith('/repos/source/repo')) return json({ id: 7, private: mode === 'private' })
        if (c.url.includes('/git/ref/')) return json({ object: { sha } })
        if (mode === 'forbidden') return json({}, 403)
        return json({ private: false })
      })
      await expect(ensureShadow('me', 'source', 'repo', 'feature/a', OAUTH, SIGNAL, () => {}, { fetch })).rejects.toThrow()
      expect(fetch.calls.every(c => c.method === 'GET')).toBe(true)
    }
  })
  test("reuses only a verified private shadow and distinct identities yield distinct names", async () => {
    const names = []
    for (const branch of ['feature/a', 'feature-a']) {
      const fetch = fakeFetch(c => {
        if (c.url.endsWith('/repos/source/repo')) return json({ id: 7, private: false })
        if (c.url.endsWith(INDEX)) return json({ semantic_code_search_ok: true, semantic_commit_sha: sha })
        if (c.url.includes('/git/ref/')) return json({ object: { sha } })
        const name = c.url.split('/').pop()
        names.push(name)
        return json({ private: true, description: `githubrepo-shadow-v1:${name.slice(-64)}`, owner: { login: 'me' }, fork: false, default_branch: 'githubrepo-shadow' })
      })
      const result = await ensureShadow('me', 'source', 'repo', branch, OAUTH, SIGNAL, () => {}, { fetch })
      expect(result.sourceSha).toBe(sha)
      expect(fetch.calls.every(c => c.method === 'GET')).toBe(true)
    }
    expect(new Set(names).size).toBe(2)
  })
  test("synchronizes with gh credentials and cleans up on success, push failure, and identity mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-shadow-test-'))
    const log = join(dir, 'git-log')
    const ghLog = join(dir, 'gh-log')
    const keys = ['PATH', 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_TRACE', 'FAKE_PUSH_FAIL']
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    const oldSha = 'b'.repeat(40)
    try {
      writeFileSync(join(dir, 'gh'), `#!/bin/sh\nprintf '%s|%s\\n' "$GH_TOKEN" "$*" >> '${ghLog}'\nif [ "$1 $2" = 'auth token' ]; then printf 'git-token\\n'; fi\n`)
      writeFileSync(join(dir, 'git'), `#!/bin/sh\nprintf '%s|%s|%s|%s|%s\\n' "$PWD" "$GH_TOKEN" "$GIT_TRACE" "$GITHUB_TOKEN" "$*" >> '${log}'\ncase "$*" in\n  *rev-parse*) printf '${sha}\\n';;\n  *fetch*|*push*) gh auth git-credential get; case "$*" in *push*) [ "$FAKE_PUSH_FAIL" = 1 ] && exit 1;; esac;;\nesac\nexit 0\n`)
      chmodSync(join(dir, 'gh'), 0o700)
      chmodSync(join(dir, 'git'), 0o700)
      process.env.PATH = `${dir}:${saved.PATH}`
      process.env.GH_TOKEN = 'ambient-gh'
      process.env.GITHUB_TOKEN = 'ambient-github'
      process.env.GIT_TRACE = '1'
      for (const mode of ['success', 'push-failure', 'identity-mismatch']) {
        writeFileSync(log, '')
        writeFileSync(ghLog, '')
        process.env.FAKE_PUSH_FAIL = mode === 'push-failure' ? '1' : '0'
        let refs = 0
        const fetch = fakeFetch(c => {
          if (c.url.endsWith('/repos/source/repo')) return json({ id: 7, private: false })
          if (c.url.endsWith('/user')) return json({ login: mode === 'identity-mismatch' ? 'other' : 'me' })
          if (c.url.endsWith(INDEX)) return json({ semantic_code_search_ok: true, semantic_commit_sha: sha })
          if (c.url.includes('/repos/source/repo/git/ref/')) return json({ object: { sha } })
          if (c.url.includes('/git/ref/')) return json({ object: { sha: refs++ === 0 ? oldSha : sha } })
          const name = c.url.split('/').pop()
          return json({ private: true, description: `githubrepo-shadow-v1:${name.slice(-64)}`, owner: { login: 'me' }, fork: false, default_branch: 'githubrepo-shadow' })
        })
        const run = ensureShadow('me', 'source', 'repo', 'feature/a', OAUTH, SIGNAL, () => {}, { fetch })
        if (mode === 'success') expect((await run).sourceSha).toBe(sha)
        else await expect(run).rejects.toThrow(mode === 'push-failure' ? 'Git shadow synchronization failed' : 'identity does not match')
        expect(fetch.calls.find(c => c.url.endsWith('/user')).auth).toBe('Bearer git-token')
        expect(fetch.calls.filter(c => !c.url.endsWith('/user')).every(c => c.auth === `Bearer ${OAUTH}`)).toBe(true)
        const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
        if (mode === 'identity-mismatch') {
          expect(lines).toHaveLength(0)
          expect(refs).toBe(1)
          continue
        }
        expect(lines).toHaveLength(4)
        const records = lines.map(line => line.split('|'))
        const cwd = records[0][0]
        expect(existsSync(cwd)).toBe(false)
        for (const [path, token, trace, githubToken, args] of records) {
          expect(path).toBe(cwd)
          expect(token).toBe('git-token')
          expect(trace).toBe('')
          expect(githubToken).toBe('')
          expect(args).toContain('credential.helper=!gh auth git-credential')
          for (const secret of ['git-token', OAUTH, 'ambient-gh', 'ambient-github']) expect(args).not.toContain(secret)
        }
        expect(records[0][4]).toContain('init --bare .')
        expect(records[1][4]).toContain('fetch --no-tags https://github.com/source/repo.git refs/heads/feature/a:refs/heads/source')
        expect(records[2][4]).toContain('rev-parse refs/heads/source')
        expect(records[3][4]).toContain(`push --force-with-lease=refs/heads/githubrepo-shadow:${oldSha}`)
        expect(records[3][4]).toContain('refs/heads/source:refs/heads/githubrepo-shadow')
        const ghLines = readFileSync(ghLog, 'utf8').trim().split('\n')
        expect(ghLines).toEqual(['ambient-gh|auth token', 'git-token|auth git-credential get', 'git-token|auth git-credential get'])
        expect(refs).toBe(mode === 'success' ? 2 : 1)
        if (mode === 'push-failure') expect(fetch.calls.some(c => c.url.endsWith(INDEX))).toBe(false)
      }
    } finally {
      for (const key of keys) restore(key, saved[key])
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("requires verified index and result commits and pins source links", async () => {
    for (const mode of ['missing-index', 'stale-index', 'bad-result', 'ok']) {
      const fetch = fakeFetch(c => {
        if (c.url.endsWith(INDEX)) {
          if (c.method === 'POST') return json({})
          if (mode === 'missing-index') return json({}, 404)
          return json({ semantic_code_search_ok: true, semantic_commit_sha: mode === 'stale-index' ? 'b'.repeat(40) : sha })
        }
        return hits([{ ...RESULT, location: { ...RESULT.location, commit_sha: mode === 'bad-result' ? 'b'.repeat(40) : sha } }])
      })
      const run = executeSearch({ repo: 'owner/repo', query: 'code', branch: 'feature' }, deps(fetch, {
        getAuthUser: async () => 'me', ensureShadow: async () => ({ shadowOwner: 'me', shadowRepo: 'shadow', sourceSha: sha }),
      }))
      if (mode === 'ok') expect((await run).text).toContain(`/blob/${sha}/`)
      else {
        await expect(run).rejects.toThrow(mode === 'bad-result' ? 'unverified commit' : 'index')
        if (mode !== 'bad-result') expect(fetch.search()).toHaveLength(0)
      }
    }
  })
})

describe("error redaction", () => {
  test("sanitizeUpstreamBody strips bearer/github tokens and token JSON fields, keeps bounded diagnostics", () => {
    const body =
      'status 500: {"authorization":"Bearer ghp_FAKEFAKEFAKEFAKEFAKEFAKE","access_token":"supersecretvalue","login":"octocat"}'
    const out = sanitizeUpstreamBody(body)
    expect(out).not.toContain("ghp_")
    expect(out).not.toContain("supersecretvalue")
    expect(out).toContain("[redacted]")
    expect(out).toContain("octocat")
    expect(out).toContain("status 500")
    const bounded = sanitizeUpstreamBody("x".repeat(600), 100)
    expect(bounded.length).toBeLessThan(200)
    expect(bounded).toContain("[truncated 500 chars]")
  })

  test("thrown search errors never expose upstream tokens", async () => {
    const leaky = (status) =>
      fakeFetch((c) => (c.url.endsWith(INDEX) ? json({ message: "Not Found" }, 404) : new Response(LEAKY_JSON, { status })))
    const err500 = await executeSearch({ repo: "owner/repo", query: "code" }, deps(leaky(500))).catch((e) => e)
    expect(err500.message).toContain("Search failed (500)")
    expect(err500.message).not.toContain("supersecretvalue")
    expect(err500.message).not.toContain("ghp_")

    const fetch404 = fakeFetch((c) =>
      c.url.endsWith(INDEX) ? json({ message: "Not Found" }, 404) : new Response(BODY_404, { status: 404 }))
    const err404 = await executeSearch({ repo: "owner/repo", query: "code" }, deps(fetch404, { tokens: {} })).catch((e) => e)
    expect(err404.message).toContain("token-scope issue")
    expect(err404.message).not.toContain("supersecretvalue")
  })
})
