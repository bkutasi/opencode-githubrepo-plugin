// v2/core.mjs — OpenCode V2 port of the opencode-githubrepo search pipeline.
//
// Faithful ESM port of the pure logic in ../index.ts (committed HEAD e9a7507),
// with NO OpenCode imports: this module is plain host-agnostic JS so both the
// V2 backend plugin (server.mjs) and the V2 unit tests can use it without any
// runtime dependency on V1 packages. V1 index.ts is intentionally untouched;
// this copy exists so the V2 port is a self-contained entrypoint that uses
// only public V2 plugin APIs on the plugin surface.
//
// Environment contract is identical to V1 (GITHUBREPO_* envs, gh CLI,
// githubrepo-config.json, OpenCode Copilot OAuth auth.json).

import { execSync, execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// ─── Config from environment ─────────────────────────────────────────────────

const API = "https://api.github.com"
const MAX_RESULTS = Number(process.env.GITHUBREPO_MAX_RESULTS) || 64
const EMBEDDING_MODEL = process.env.GITHUBREPO_EMBEDDING_MODEL ?? "metis-1024-I16-Binary"
const MAX_QUERY_BYTES = Number(process.env.GITHUBREPO_MAX_QUERY_BYTES) || 7800
const POLL_ATTEMPTS = Number(process.env.GITHUBREPO_POLL_ATTEMPTS) || 10
export const POLL_DELAY = Number(process.env.GITHUBREPO_POLL_DELAY_MS) || 1000
const API_VERSION = process.env.GITHUBREPO_API_VERSION ?? "2022-11-28"
const BRANCH_SEARCH = (process.env.GITHUBREPO_BRANCH_SEARCH ?? "true") !== "false"
const BRANCH_TIMEOUT = Number(process.env.GITHUBREPO_BRANCH_TIMEOUT) || 180000
const SEARCH_TIMEOUT = Number(process.env.GITHUBREPO_SEARCH_TIMEOUT) || 120000
const SHADOW_PREFIX = process.env.GITHUBREPO_SHADOW_PREFIX || "tmp-ghrtool"
const SYNC_URL = process.env.TOKEN_SYNC_URL ?? ""
const SYNC_SECRET = process.env.TOKEN_SYNC_SECRET ?? ""
const SYNC_MODE = !!(SYNC_URL && SYNC_SECRET)
// Prefer `gh auth token` for search primary (private-repo-heavy use); flips the scope-404
// retry direction too. Default (unset) keeps Copilot OAuth primary (entitlement-gated public repos).
// Resolved per call (not at module load) so injected-dependency tests are deterministic.
function preferGh() {
  return (process.env.GITHUBREPO_PREFER_GH ?? "") === "1"
}
/** Embeddings search uses only `gh auth token` — no Copilot OAuth primary or scope-404 retry. */
function ghOnly() {
  return (process.env.GITHUBREPO_GH_ONLY ?? "") === "1"
}
const CONFIG_FILE_NAME = "githubrepo-config.json"

function tokenSyncLivePaths() {
  const paths = [
    join(opencodeDataDir(), "copilot-runtime", "token-sync-live.json"),
    join(defaultShareDir(), "opencode", "copilot-runtime", "token-sync-live.json"),
  ]
  return [...new Set(paths)]
}

function sharedOauthTokenPath() {
  return join(defaultShareDir(), "copilot-shared-token.json")
}

function defaultShareDir() {
  return join(homedir(), ".local", "share")
}

function expandUserPath(p) {
  const t = p.trim()
  if (t === "~") return homedir()
  if (t.startsWith("~/")) return join(homedir(), t.slice(2))
  return t
}

/** OpenCode data dir: respects XDG_DATA_HOME (e.g. fork wrapper); else ~/.local/share/opencode */
function opencodeDataDir() {
  return join(process.env.XDG_DATA_HOME ?? defaultShareDir(), "opencode")
}

/**
 * OpenCode Copilot OAuth (`github-copilot` in auth.json). First readable wins.
 * Defaults match upstream: ~/.local/share/opencode/auth.json (no wrapper env required).
 */
function opencodeAuthJsonPaths() {
  const paths = []
  const push = (p) => {
    if (p && !paths.includes(p)) paths.push(p)
  }
  const cfg = readSearchConfig()
  if (process.env.GITHUBREPO_AUTH_JSON?.trim()) push(expandUserPath(process.env.GITHUBREPO_AUTH_JSON))
  if (cfg.authJson?.trim()) push(expandUserPath(cfg.authJson))
  const vanilla = join(defaultShareDir(), "opencode", "auth.json")
  push(vanilla)
  const xdgAuth = join(opencodeDataDir(), "auth.json")
  if (xdgAuth !== vanilla) push(xdgAuth)
  return paths.filter(Boolean)
}

export function readSearchConfig() {
  const dir = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
  try {
    return JSON.parse(readFileSync(join(dir, CONFIG_FILE_NAME), "utf8"))
  } catch {
    return {}
  }
}

function cfgSecondsToMs(value, fallbackMs) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : fallbackMs
}

export function envMsOrCfgSeconds(envName, cfgValue, fallbackMs) {
  const envValue = process.env[envName]
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs
  }
  return cfgSecondsToMs(cfgValue, fallbackMs)
}

export function isAbortError(err, signal) {
  return err?.name === "AbortError" || err?.name === "TimeoutError" || !!signal?.aborted
}

// ─── Description ─────────────────────────────────────────────────────────────

export const DESCRIPTION = `- Semantic code search across GitHub repositories using Copilot's embeddings index
- Searches the full codebase of any GitHub repository you have access to (public and private)
- Returns relevant code snippets with file paths, line numbers, and similarity scores
- Automatically triggers indexing for repositories that haven't been indexed yet
- Use this when you need to find code in a remote GitHub repository without cloning it
- Requires GitHub Copilot authentication (github-copilot provider)

Usage notes:
  - The repo parameter accepts "owner/repo" format or full GitHub URLs (supports /tree/branch-name)
  - Returns up to 64 code snippets ranked by semantic relevance
  - Results include direct GitHub links to the matching code
  - If a repository is not yet indexed, the tool will trigger indexing and wait up to 10 seconds
  - Large repositories may take longer to index on first use

Branch search (non-default branches):
  - Omit branch when searching the repository default branch. Passing the default branch
    still triggers shadow-repo mode and is slower/error-prone.
  - The embeddings API only indexes the default branch. To search other branches, the tool
    creates persistent private managed shadow repos under your account named tmp-ghrtool-{hash}.
  - Set the branch parameter or include /tree/branch-name in the URL
  - Synchronizes branch history using git and gh; private or unknown-visibility sources require GITHUBREPO_ALLOW_PRIVATE_SHADOW=true.
  - Shadow repos are persistent — reused on subsequent searches (no re-creation overhead)
  - First search on a new branch is slower (~15-60s for indexing)
  - To clean up shadow repos: delete repos matching tmp-ghrtool-* from your account
  - Disable with GITHUBREPO_BRANCH_SEARCH=false

Filtering:
  - Use path parameter to filter by file paths: ["src/", "README.md"]
  - Use lang parameter to filter by language: ["TypeScript", "Python"]

Examples:
  - Basic: { "repo": "facebook/react", "query": "reconciler fiber scheduling" }
  - With URL: { "repo": "https://github.com/facebook/react", "query": "hooks implementation" }
  - Branch via URL: { "repo": "https://github.com/owner/repo/tree/feature-x", "query": "new api" }
  - Branch via param: { "repo": "owner/repo", "query": "search term", "branch": "develop" }
  - Search 3 branches: call 3 times with branch "main", "staging", "feature-x"
  - With filters: { "repo": "owner/repo", "query": "error handling", "path": ["src/"], "lang": ["TypeScript"] }

Environment variables:
  - GITHUBREPO_AUTH_JSON: explicit path to OpenCode auth.json (overrides auto-discovery)
  - XDG_DATA_HOME: OpenCode data root (auth at $XDG_DATA_HOME/opencode/auth.json); standard on Linux when unset
  - GITHUBREPO_OPENCODE_AUTH_FALLBACK: "false" disables reading OpenCode auth.json
  - GITHUBREPO_BRANCH_SEARCH: "true" (default) or "false" to disable branch search
  - GITHUBREPO_BRANCH_TIMEOUT: ms to wait for branch index (default: 180000)
  - GITHUBREPO_SHADOW_PREFIX: prefix for shadow repos (default: "tmp-ghrtool")
  - GITHUBREPO_MAX_RESULTS: max results (default: 64)
  - GITHUBREPO_POLL_DELAY_MS: polling interval ms (default: 1000)
  - GITHUBREPO_POLL_ATTEMPTS: max poll attempts for default branch (default: 10)
  - GITHUBREPO_PREFER_GH: "1" to try gh before Copilot OAuth (default unset → OAuth first)
  - GITHUBREPO_GH_ONLY: "1" for embeddings search via gh only — no OAuth, no scope-404 retry (opencode-wrapper default)`

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    })
  })
}

export function parseRepo(input) {
  const simple = input.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (simple) return { owner: simple[1], repo: simple[2] }
  try {
    const url = new URL(input)
    if (url.hostname === "github.com") {
      const parts = url.pathname.split("/").filter(Boolean)
      if (parts.length >= 2) {
        const result = { owner: parts[0], repo: parts[1] }
        if (parts.length >= 4 && parts[2] === "tree") {
          result.branch = parts.slice(3).join("/")
        }
        return result
      }
    }
  } catch {
    /* not a URL */
  }
  return undefined
}

function hdrs(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": process.env.GITHUBREPO_USER_AGENT ?? "GitHubCopilot/1.0",
  }
}

/**
 * HTTP seam. `io.fetch` is only ever supplied by tests (executeSearch deps);
 * production calls pass no `io` and use global fetch.
 */
async function ghFetch(url, init = {}, io) {
  const fetchFn = io?.fetch ?? fetch
  return fetchFn(url, init)
}

// ─── Error sanitization (V2-only) ─────────────────────────────────────────────
//
// Upstream GitHub bodies can echo request context back. Every body that reaches
// a thrown error is normalized: credential-shaped substrings and JSON token /
// authorization fields are replaced, and the remainder is length-bounded so the
// status/repository diagnostics stay useful without dumping an unbounded payload.

const REDACTED = "[redacted]"
const SANITIZED_MAX = 300

export function sanitizeUpstreamBody(text, maxLen = SANITIZED_MAX) {
  if (text == null) return ""
  let out = String(text)
  out = out.replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, REDACTED)
  out = out.replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
  out = out.replace(
    /("?(?:access_token|oauth_token|refresh_token|auth_token|authorization|token)"?\s*[:=]\s*)("?)[^"\s,}]+(\2)/gi,
    `$1$2${REDACTED}$3`
  )
  if (out.length > maxLen) out = `${out.slice(0, maxLen)}…[truncated ${out.length - maxLen} chars]`
  return out
}

function readCopilotOauthFromAuthJson(authPath) {
  try {
    const raw = readFileSync(authPath, "utf8")
    const data = JSON.parse(raw)
    const auth = data["github-copilot"]
    if (auth?.type === "oauth") return (auth.refresh ?? auth.access)
  } catch {
    /* unreadable or missing */
  }
  return undefined
}

function readOpencodeCopilotOauth() {
  if (process.env.GITHUBREPO_OPENCODE_AUTH_FALLBACK === "false") return undefined
  for (const authPath of opencodeAuthJsonPaths()) {
    const token = readCopilotOauthFromAuthJson(authPath)
    if (token) return token
  }
  return undefined
}

function readOauthTokenFrom(path) {
  try {
    const raw = readFileSync(path, "utf8")
    const data = JSON.parse(raw)
    if (data.oauth_token) return data.oauth_token
  } catch {
    /* unreadable */
  }
  return undefined
}

function getGhCliToken() {
  try {
    const ghToken = execSync("gh auth token", { encoding: "utf-8", timeout: 5000 }).trim()
    return ghToken || undefined
  } catch {
    return undefined
  }
}

/**
 * Candidate tokens for embeddings search (plugin-only; token-sync is opt-in via SYNC_MODE).
 *   - copilotOauth: OpenCode auth.json `github-copilot` OAuth — covers entitlement-gated PUBLIC repos
 *   - gh: `gh auth token` — covers PRIVATE repos (classic PAT repo scope)
 */
export function resolveCopilotTokens() {
  return { copilotOauth: readOpencodeCopilotOauth(), gh: getGhCliToken() }
}

/** Pick the primary token for embeddings search. `preferGh` (GITHUBREPO_PREFER_GH=1) reverses the order. */
export function pickPrimaryToken(tokens, preferGh) {
  return preferGh ? (tokens.gh ?? tokens.copilotOauth) : (tokens.copilotOauth ?? tokens.gh)
}

/** Pick the OTHER token to retry on an embeddings scope-404 (bidirectional fallback). */
export function pickScopeFallback(primaryToken, tokens) {
  if (primaryToken && primaryToken === tokens.gh) return tokens.copilotOauth
  if (primaryToken && primaryToken === tokens.copilotOauth) return tokens.gh
  return tokens.gh ?? tokens.copilotOauth
}

export async function getToken() {
  // Explicit opt-in legacy infra (TOKEN_SYNC_URL + TOKEN_SYNC_SECRET both set):
  // token-sync-live.json then copilot-shared-token.json. Refuses any other fallback.
  if (SYNC_MODE) {
    for (const p of tokenSyncLivePaths()) {
      const syncOauth = readOauthTokenFrom(p)
      if (syncOauth) return syncOauth
    }
    const shared = readOauthTokenFrom(sharedOauthTokenPath())
    if (shared) return shared
    throw new Error(
      "TOKEN_SYNC is active but no oauth_token in token-sync-live.json or copilot-shared-token.json. Refusing auth fallback."
    )
  }

  const tokens = resolveCopilotTokens()
  if (ghOnly()) {
    if (!tokens.gh) {
      throw new Error(
        "GITHUBREPO_GH_ONLY=1 but `gh auth token` failed. Run `gh auth login` (repo scope), start OpenCode via opencode-wrapper so the MCP inherits env."
      )
    }
    return tokens.gh
  }
  // Copilot OAuth (public entitlement) ↔ `gh auth token` (private repo). PREFER_GH=1 → gh first.
  return pickPrimaryToken(tokens, preferGh())
}

// ─── Index management ─────────────────────────────────────────────────────────

export async function checkIndex(owner, repo, token, signal, io) {
  const response = await ghFetch(`${API}/repos/${owner}/${repo}/copilot_internal/embeddings_index`, {
    method: "GET",
    headers: hdrs(token),
    signal,
  }, io)
  if (!response.ok) {
    // GitHub often 404s embeddings_index while POST /embeddings/code/search still works (VS Code github_repo tool behavior).
    if (response.status === 404) {
      return { state: "ready" }
    }
    return { state: "error" }
  }
  const data = await response.json()
  if (data.semantic_code_search_ok && data.semantic_commit_sha) return { state: "ready", sha: data.semantic_commit_sha }
  if (data.semantic_indexing_enabled) return { state: "building" }
  return { state: "not-indexed" }
}

export async function triggerIndex(owner, repo, token, signal, io) {
  const response = await ghFetch(`${API}/repos/${owner}/${repo}/copilot_internal/embeddings_index`, {
    method: "POST",
    headers: hdrs(token),
    body: JSON.stringify({ auto: false }),
    signal,
  }, io)
  return response.ok
}

export async function waitForIndex(owner, repo, token, signal, attempts, io) {
  const check = io?.check ?? checkIndex
  const nap = io?.sleep ?? sleep
  for (let i = 0; i < attempts; i++) {
    await nap(POLL_DELAY, signal)
    const info = await check(owner, repo, token, signal, io)
    if (info.state === "ready") return info
    if (info.state === "error") return info
  }
  return { state: "building" }
}

export async function getAuthUser(token, signal, io) {
  const res = await ghFetch(`${API}/user`, { headers: hdrs(token), signal }, io)
  if (!res.ok) return undefined
  return (await res.json()).login
}

export async function verifyShadowIndex(info, sha, owner, repo, token, signal, io) {
  if (info.state !== "ready" || info.sha === sha) return
  if (!await triggerIndex(owner, repo, token, signal, io)) throw new Error(`Failed to trigger indexing for ${owner}/${repo}.`)
  throw new Error(info.sha ? "Shadow index is stale; indexing requested. Retry later." : "Cannot verify shadow index SHA; indexing requested. Retry later.")
}

const runGit = promisify(execFile)
const SHADOW_BRANCH = "githubrepo-shadow"

export async function ensureShadow(
  login, owner, repo, branch, token, signal, onStatus, io
) {
  if (![login, owner, repo].every(v => /^[a-zA-Z0-9_.-]+$/.test(v) && v !== "." && v !== "..") || !branch || branch.startsWith("-") || branch.includes("\0")) {
    throw new Error("Invalid repository or branch name.")
  }
  const sourceUrl = `${API}/repos/${owner}/${repo}`
  const source = await ghFetch(sourceUrl, { headers: hdrs(token), signal }, io)
  if (!source.ok) throw new Error(`Cannot access source repository (${source.status}).`)
  const sourceData = await source.json()
  if (!Number.isSafeInteger(sourceData.id)) throw new Error("Source repository has no stable identity.")
  if (sourceData.private !== false && process.env.GITHUBREPO_ALLOW_PRIVATE_SHADOW !== "true") {
    throw new Error("Private or unknown-visibility source requires GITHUBREPO_ALLOW_PRIVATE_SHADOW=true; shadow copies persist independently of the source.")
  }
  const identity = JSON.stringify([sourceData.id, branch])
  const hash = createHash("sha256").update(identity).digest("hex")
  const prefix = SHADOW_PREFIX.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40) || "tmp-ghrtool"
  const sname = `${prefix}-${hash}`
  const marker = `githubrepo-shadow-v1:${hash}`
  const shadowUrl = `${API}/repos/${login}/${sname}`
  const branchUrl = `${sourceUrl}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`
  const getSourceSha = async () => {
    const res = await ghFetch(branchUrl, { headers: hdrs(token), signal }, io)
    if (!res.ok) throw new Error(`Cannot resolve source branch (${res.status}).`)
    const sha = (await res.json()).object?.sha
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid source commit SHA.")
    return sha
  }
  const sha = await getSourceSha()
  let shadow = await ghFetch(shadowUrl, { headers: hdrs(token), signal }, io)
  if (shadow.status === 404) {
    onStatus(`Creating private shadow ${sname}...`)
    const created = await ghFetch(`${API}/user/repos`, {
      method: "POST", headers: hdrs(token), signal,
      body: JSON.stringify({ name: sname, private: true, description: marker, auto_init: false }),
    }, io)
    if (!created.ok) throw new Error(`Cannot create shadow repository (${created.status}); no repository was modified.`)
    shadow = await ghFetch(shadowUrl, { headers: hdrs(token), signal }, io)
  }
  if (!shadow.ok) throw new Error(`Cannot inspect shadow repository (${shadow.status}).`)
  const data = await shadow.json()
  if (data.private !== true || data.description !== marker || data.owner?.login?.toLowerCase() !== login.toLowerCase() || data.fork === true) {
    throw new Error(`Shadow name collision or invalid provenance for ${login}/${sname}; refusing to modify it.`)
  }
  const refUrl = `${shadowUrl}/git/ref/heads/${SHADOW_BRANCH}`
  const ref = await ghFetch(refUrl, { headers: hdrs(token), signal }, io)
  if (!ref.ok && ref.status !== 404 && ref.status !== 409) throw new Error(`Cannot inspect shadow ref (${ref.status}).`)
  const oldSha = ref.ok ? (await ref.json()).object?.sha : ""
  if (ref.ok && (typeof oldSha !== "string" || !/^[0-9a-f]{40}$/.test(oldSha))) throw new Error("Invalid shadow ref SHA.")
  if (oldSha !== sha) {
    const gitToken = getGhCliToken()
    if (!gitToken) throw new Error("Git shadow synchronization requires a gh CLI token; run gh auth login.")
    const gitLogin = await getAuthUser(gitToken, signal, io)
    if (typeof gitLogin !== "string" || gitLogin.toLowerCase() !== login.toLowerCase()) throw new Error("gh CLI token identity does not match the shadow owner; refusing to synchronize.")
    onStatus(`Synchronizing private shadow ${sname}...`)
    const dir = await mkdtemp(join(tmpdir(), "githubrepo-"))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !key.startsWith("GH_") && key !== "GITHUB_TOKEN"))
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GH_PROMPT_DISABLED: "1", GH_HOST: "github.com", GH_TOKEN: gitToken })
    const git = async (...args) => {
      try {
        return await runGit("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "-c", "http.followRedirects=false", ...args], { cwd: dir, env, signal, maxBuffer: 1024 * 1024 })
      } catch (err) {
        if (isAbortError(err, signal)) throw err
        throw new Error("Git shadow synchronization failed. Ensure git and gh are installed and gh is authenticated with repository access.")
      }
    }
    try {
      await git("init", "--bare", ".")
      await git("fetch", "--no-tags", `https://github.com/${owner}/${repo}.git`, `refs/heads/${branch}:refs/heads/source`)
      const fetched = (await git("rev-parse", "refs/heads/source")).stdout.trim()
      if (fetched !== sha) throw new Error("Source branch changed during synchronization; retry.")
      await git("push", `--force-with-lease=refs/heads/${SHADOW_BRANCH}:${oldSha}`, `https://github.com/${login}/${sname}.git`, `refs/heads/source:refs/heads/${SHADOW_BRANCH}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const verified = await ghFetch(refUrl, { headers: hdrs(token), signal }, io)
  if (!verified.ok || (await verified.json()).object?.sha !== sha || await getSourceSha() !== sha) throw new Error("Shadow or source branch changed during synchronization; retry.")
  if (data.default_branch !== SHADOW_BRANCH) {
    const updated = await ghFetch(shadowUrl, { method: "PATCH", headers: hdrs(token), signal, body: JSON.stringify({ default_branch: SHADOW_BRANCH }) }, io)
    if (!updated.ok) throw new Error(`Cannot set shadow default branch (${updated.status}).`)
  }
  const info = await checkIndex(login, sname, token, signal, io)
  await verifyShadowIndex(info, sha, login, sname, token, signal, io)
  return { shadowOwner: login, shadowRepo: sname, sourceSha: sha }
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export function coerceStringArray(value) {
  if (value == null) return undefined
  if (Array.isArray(value)) {
    const out = value.map((x) => String(x).trim()).filter(Boolean)
    return out.length ? out : undefined
  }
  if (typeof value === "string" && value.trim()) return [value.trim()]
  return undefined
}

function normalizePathFilters(path) {
  if (!path?.length) return undefined
  const out = path
    .map((p) => p.trim().replace(/\/+$/, ""))
    .filter(Boolean)
  return out.length ? out : undefined
}

export function filterResultsByPathPrefix(results, paths) {
  const prefixes = normalizePathFilters(paths)
  if (!prefixes?.length) return results
  return results.filter((r) => {
    const p = r.location.path
    return prefixes.some((pref) => p === pref || p.startsWith(`${pref}/`))
  })
}

/** Embeddings API accepts only `repo:owner/name`; path/lang/notPath in scoping_query 404 on private repos. */
export function buildScopingQuery(_owner, _repo, _path, _lang) {
  return `repo:${_owner}/${_repo}`
}

// ─── Search ───────────────────────────────────────────────────────────────────

export function isEmbeddingsScopeDenied(status, text) {
  return (
    status === 404 &&
    text.includes("repository not found") &&
    text.includes("protected_org_ids")
  )
}

async function searchOnce(owner, repo, trimmed, token, signal, path, lang, opts) {
  const response = await ghFetch(`${API}/embeddings/code/search`, {
    method: "POST",
    headers: hdrs(token),
    body: JSON.stringify({
      scoping_query: buildScopingQuery(owner, repo, path, lang),
      prompt: trimmed,
      include_embeddings: false,
      limit: opts?.maxResults ?? MAX_RESULTS,
      embedding_model: opts?.embeddingModel ?? EMBEDDING_MODEL,
    }),
    signal,
  }, opts?.io)

  if (!response.ok) {
    return { ok: false, status: response.status, text: await response.text() }
  }

  const data = await response.json()
  return { ok: true, results: data.results ?? [] }
}

export async function search(owner, repo, query, token, signal, path, lang, opts) {
  const encoder = new TextEncoder()
  let trimmed = query
  while (encoder.encode(trimmed).length > MAX_QUERY_BYTES) {
    trimmed = trimmed.slice(0, -100)
  }

  let attempt = await searchOnce(owner, repo, trimmed, token, signal, path, lang, opts)
  if (
    !ghOnly() &&
    !attempt.ok &&
    isEmbeddingsScopeDenied(attempt.status, attempt.text)
  ) {
    // Candidate tokens come from injected deps in tests; production reads real creds.
    const candidates = opts?.tokens ?? resolveCopilotTokens()
    const fallback = pickScopeFallback(token, candidates)
    if (fallback && fallback !== token) {
      const retry = await searchOnce(owner, repo, trimmed, fallback, signal, path, lang, opts)
      if (retry.ok) return retry.results
      if (!retry.ok) attempt = retry
    }
  }

  if (!attempt.ok) {
    const { status, text } = attempt
    if (isEmbeddingsScopeDenied(status, text)) {
      throw new Error(
        `Embeddings search returned 404 "repository not found" for repo:${owner}/${repo} with the current token(s). ` +
          `This is often a token-scope issue (Copilot OAuth vs \`gh auth token\`) or missing Copilot indexing for that repo — not a malformed owner/repo. ` +
          `Use exact "owner/repo" (case-sensitive owner). Raw: ${sanitizeUpstreamBody(text)}`
      )
    }
    throw new Error(`Search failed (${status}): ${sanitizeUpstreamBody(text)}`)
  }

  return attempt.results
}

export function dedupeAndFilter(results) {
  if (!results.length) return results
  const sorted = [...results].sort((a, b) => a.distance - b.distance)
  const topScore = 1 - sorted[0].distance
  const filtered = sorted.filter((r) => (1 - r.distance) >= topScore - 0.65)
  const seen = new Map()
  const out = []
  for (const r of filtered) {
    const key = r.location.path
    const ranges = seen.get(key) ?? []
    if (ranges.some((e) => r.chunk.line_range.start < e.end && r.chunk.line_range.end > e.start)) continue
    ranges.push({ start: r.chunk.line_range.start, end: r.chunk.line_range.end })
    seen.set(key, ranges)
    out.push(r)
  }
  return out
}

export function format(results, owner, repo, branch) {
  if (results.length === 0) return "No results found."
  return results
    .map((r, i) => {
      const start = r.chunk.line_range.start
      const end = r.chunk.line_range.end
      const ref = branch ?? r.location.ref_name?.replace("refs/heads/", "") ?? "main"
      const url = `https://github.com/${owner}/${repo}/blob/${ref}/${r.location.path}#L${start}-L${end}`
      const score = (1 - r.distance).toFixed(3)
      return [
        `## Result ${i + 1} — ${r.location.path} (L${start}-L${end}) [score: ${score}]`,
        url,
        "```",
        r.chunk.text.trimEnd(),
        "```",
      ].join("\n")
    })
    .join("\n\n")
}

// ─── Tool orchestration ───────────────────────────────────────────────────────
//
// Mirrors the V1 plugin tool `execute` body (index.ts) exactly:
// token → repo parse → optional branch shadow → index check/trigger → search →
// client-side path filter → dedupe/quality filter → formatted text + title.

/**
 * `deps` is an optional test seam — production calls pass nothing and keep the
 * real credential/gh/network paths. Recognized keys (all optional):
 *   token        primary search token (skips credential resolution)
 *   tokens       candidate token set { copilotOauth, gh } for scope-404 fallback
 *   getToken     async () => token override
 *   fetch        fetch implementation (defaults to global fetch)
 *   sleep        sleep implementation (defaults to real timer)
 *   checkIndex   index-status probe (defaults to the real checkIndex)
 *   getAuthUser  auth-login lookup for branch shadowing
 *   ensureShadow shadow orchestration
 * Seam values are never logged or echoed.
 */
export async function executeSearch(input, deps = {}) {
  // V2 passes JSON-schema inputs through without validation
  // (packages/core/src/tool/runtime.ts decodeInput), so normalize defensively
  // and fail with the same friendly error V1 produces for a bad repo.
  const repoInput = typeof input?.repo === "string" ? input.repo : ""
  const queryInput = typeof input?.query === "string" ? input.query : ""
  const branchInput = typeof input?.branch === "string" ? input.branch : undefined

  const io = {
    fetch: deps.fetch,
    sleep: deps.sleep,
    check: deps.checkIndex,
  }
  const check = deps.checkIndex ?? checkIndex
  const getAuth = deps.getAuthUser ?? ((t, s) => getAuthUser(t, s, io))
  const ensure = deps.ensureShadow ?? ((...args) => ensureShadow(...args, io))

  // Read config from file (updated by /githubrepo TUI command), env vars take precedence
  const cfg = readSearchConfig()
  const searchTimeout = envMsOrCfgSeconds("GITHUBREPO_SEARCH_TIMEOUT", cfg.searchTimeout, 120000)
  const branchTimeout = envMsOrCfgSeconds("GITHUBREPO_BRANCH_TIMEOUT", cfg.branchTimeout, 180000)
  const maxResults = Number(process.env.GITHUBREPO_MAX_RESULTS || cfg.maxResults) || 64
  const embeddingModel = process.env.GITHUBREPO_EMBEDDING_MODEL || cfg.embeddingModel || "metis-1024-I16-Binary"
  const pollAttemptsCfg = Number(process.env.GITHUBREPO_POLL_ATTEMPTS || cfg.pollAttempts) || 10
  const branchSearch = (process.env.GITHUBREPO_BRANCH_SEARCH ?? "true") !== "false"

  // V2 tool contexts carry no abort signal; bound the call with a timeout
  // (V1 combined ctx.abort with the same timeout).
  const signal = AbortSignal.timeout(searchTimeout)
  try {
    const token = deps.token ?? await (deps.getToken ?? getToken)()
    if (!token) {
      throw new Error(
        "Not authenticated for GitHub Copilot embeddings. Run `opencode auth login` and choose github-copilot, and/or `gh auth login` (repo scope for private repos). No custom env or fork wrapper required."
      )
    }

    const parsed = parseRepo(repoInput)
    if (!parsed) throw new Error(`Invalid repository format: "${repoInput}". Use "owner/repo" or a GitHub URL.`)

    const branch = branchInput ?? parsed.branch
    const needsBranch = !!branch && branchSearch
    const pollAttempts = needsBranch ? Math.ceil(branchTimeout / POLL_DELAY) : pollAttemptsCfg

    let searchOwner = parsed.owner
    let searchRepo = parsed.repo
    let shadowSha

    if (needsBranch) {
      const login = await getAuth(token, signal)
      if (!login) throw new Error("Cannot determine authenticated user for branch search.")
      const shadow = await ensure(login, parsed.owner, parsed.repo, branch, token, signal, (msg) => {
        // surface as transient progress when a tool context is available
        progressSinks.forEach((sink) => sink({ title: msg }))
      })
      searchOwner = shadow.shadowOwner
      searchRepo = shadow.shadowRepo
      shadowSha = shadow.sourceSha
      if (typeof shadowSha !== "string" || !/^[0-9a-f]{40}$/.test(shadowSha)) throw new Error("Cannot verify shadow source SHA.")
    }

    let info
    try {
      info = await check(searchOwner, searchRepo, token, signal, io)
    } catch (err) {
      if (isAbortError(err, signal)) return { text: "Search was aborted. Try again with a more specific query.", title: "Search aborted" }
      throw err
    }

    if (info.state === "error") {
      throw new Error(`Cannot access repository ${searchOwner}/${searchRepo}. It may not exist or you may lack access.`)
    }

    if (info.state === "not-indexed") {
      const ok = await triggerIndex(searchOwner, searchRepo, token, signal, io)
      if (!ok) throw new Error(`Failed to trigger indexing for ${searchOwner}/${searchRepo}.`)
      if (needsBranch) {
        return {
          text: `Indexing ${searchOwner}/${searchRepo} for branch ${branch}. Run the same search again in a minute — the shadow repo will be ready.`,
          title: `Indexing ${searchOwner}/${searchRepo} for branch ${branch}`,
        }
      }
      info = await waitForIndex(searchOwner, searchRepo, token, signal, pollAttempts, io)
      if (info.state !== "ready") throw new Error("Repository index not ready after polling. Try again shortly.")
    } else if (info.state === "building") {
      if (needsBranch) {
        return { text: `Index still building for ${searchOwner}/${searchRepo}. Try again in a minute.`, title: `Index building` }
      }
      info = await waitForIndex(searchOwner, searchRepo, token, signal, pollAttempts, io)
      if (info.state !== "ready") throw new Error("Repository index not ready after polling. Try again shortly.")
    }

    if (shadowSha) await verifyShadowIndex(info, shadowSha, searchOwner, searchRepo, token, signal, io)

    const pathFilters = coerceStringArray(input?.path)
    const langFilters = coerceStringArray(input?.lang)
    // When path whitelist is set: repo-only scoping + client prefix filter
    // (path:/lang: in scoping_query 404s on some private repos).
    const apiPath = pathFilters?.length ? undefined : pathFilters
    const apiLang = pathFilters?.length ? undefined : langFilters
    let results = await search(searchOwner, searchRepo, queryInput, token, signal, apiPath, apiLang, {
      maxResults,
      embeddingModel,
      io,
      tokens: deps.tokens,
    })
    if (shadowSha && results.some(result => result.location?.commit_sha !== shadowSha)) throw new Error("Shadow search returned results from an unverified commit.")
    results = filterResultsByPathPrefix(results, pathFilters)
    const deduped = dedupeAndFilter(results)
    const output = format(deduped, parsed.owner, parsed.repo, shadowSha ?? branch)
    const branchLabel = branch ? ` @ ${branch}` : ""
    const suffix = deduped.length === 1 ? " result" : " results"
    const title = results.length === deduped.length
      ? `Searched ${parsed.owner}/${parsed.repo}${branchLabel} for "${queryInput}" — ${results.length}${suffix}`
      : `Searched ${parsed.owner}/${parsed.repo}${branchLabel} for "${queryInput}" — ${results.length} raw, ${deduped.length} after quality filter`
    return { text: output, title }
  } catch (err) {
    // Graceful abort: don't propagate timeout/abort errors as crashes
    if (isAbortError(err, signal)) {
      return { text: "Search was aborted due to timeout. Try a more specific query.", title: "Search aborted" }
    }
    throw err
  }
}

/** Progress sinks (tool context progress fns) registered by the V2 server plugin. */
export const progressSinks = new Set()

export function addProgressSink(sink) {
  progressSinks.add(sink)
  return () => progressSinks.delete(sink)
}