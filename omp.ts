/**
 * omp extension entry for opencode-githubrepo.
 *
 * Upstream strategy: `index.ts` (opencode plugin) and `tui.ts` (opencode TUI
 * command) are untouched. This module registers the same semantic-search
 * pipeline (`parseRepo` → shadow/index → `search` → filter/format from
 * `./index.ts`) through omp's `ExtensionAPI`, so one npm package serves both
 * hosts. Enable via package.json `omp.extensions`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  POLL_DELAY,
  checkIndex,
  coerceStringArray,
  dedupeAndFilter,
  ensureShadow,
  envMsOrCfgSeconds,
  filterResultsByPathPrefix,
  format,
  getAuthUser,
  getToken,
  isAbortError,
  parseRepo,
  readSearchConfig,
  search,
  triggerIndex,
  waitForIndex,
} from "./index.ts";

const DESCRIPTION = `Semantic code search across GitHub repositories using Copilot embeddings.
Use owner/repo or a full GitHub URL. Optional branch/path/lang filters.`;

export default function githubrepoOmpExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.registerTool({
    name: "githubrepo",
    description: DESCRIPTION,
    parameters: z.object({
      repo: z.string().describe("GitHub repository in 'owner/repo' format or full GitHub URL (supports /tree/branch-name)"),
      query: z.string().describe("Semantic search query to find relevant code"),
      branch: z
        .string()
        .describe(
          "Search a non-default branch. Creates a persistent shadow repo (tmp-ghrtool-{repo}-{branch}) for indexing. Disable with GITHUBREPO_BRANCH_SEARCH=false",
        )
        .optional(),
      path: z.array(z.string()).describe("Filter by file paths, e.g. ['src/', 'README.md']").optional(),
      lang: z.array(z.string()).describe("Filter by language, e.g. ['TypeScript']").optional(),
    }),
    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      // Config mirrors index.ts: file values, env vars take precedence.
      const cfg = readSearchConfig();
      const searchTimeout = envMsOrCfgSeconds("GITHUBREPO_SEARCH_TIMEOUT", cfg.searchTimeout, 120000);
      const branchTimeout = envMsOrCfgSeconds("GITHUBREPO_BRANCH_TIMEOUT", cfg.branchTimeout, 180000);
      const maxResults = Number(process.env.GITHUBREPO_MAX_RESULTS || cfg.maxResults) || 64;
      const embeddingModel = process.env.GITHUBREPO_EMBEDDING_MODEL || cfg.embeddingModel || "metis-1024-I16-Binary";
      const pollAttemptsCfg = Number(process.env.GITHUBREPO_POLL_ATTEMPTS || cfg.pollAttempts) || 10;
      const branchSearch = (process.env.GITHUBREPO_BRANCH_SEARCH ?? "true") !== "false";

      const timeoutSignal = AbortSignal.timeout(searchTimeout);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const token = await getToken();
        if (!token) {
          throw new Error(
            "Not authenticated for GitHub Copilot embeddings. Run `opencode auth login` and choose github-copilot, and/or `gh auth login` (repo scope for private repos).",
          );
        }

        const parsed = parseRepo(params.repo);
        if (!parsed) throw new Error(`Invalid repository format: "${params.repo}". Use "owner/repo" or a GitHub URL.`);

        const branch = params.branch ?? parsed.branch;
        const needsBranch = !!branch && branchSearch;
        const pollAttempts = needsBranch ? Math.ceil(branchTimeout / POLL_DELAY) : pollAttemptsCfg;

        let searchOwner = parsed.owner;
        let searchRepo = parsed.repo;

        if (needsBranch) {
          const login = await getAuthUser(token, combined);
          if (!login) throw new Error("Cannot determine authenticated user for branch search.");
          const shadow = await ensureShadow(login, parsed.owner, parsed.repo, branch!, token, combined, (msg) =>
            pi.logger.info(msg),
          );
          searchOwner = shadow.shadowOwner;
          searchRepo = shadow.shadowRepo;
        }

        let info = await checkIndex(searchOwner, searchRepo, token, combined).catch((err) => {
          if (isAbortError(err, combined)) throw err;
          throw err;
        });

        if (info.state === "error") {
          throw new Error(`Cannot access repository ${searchOwner}/${searchRepo}. It may not exist or you may lack access.`);
        }

        if (info.state === "not-indexed") {
          const ok = await triggerIndex(searchOwner, searchRepo, token, combined);
          if (!ok) throw new Error(`Failed to trigger indexing for ${searchOwner}/${searchRepo}.`);
          if (needsBranch) {
            return {
              content: [
                {
                  type: "text",
                  text: `Indexing ${searchOwner}/${searchRepo} for branch ${branch}. Run the same search again in a minute — the shadow repo will be ready.`,
                },
              ],
              details: { state: info.state, branch },
            };
          }
          info = await waitForIndex(searchOwner, searchRepo, token, combined, pollAttempts);
          if (info.state !== "ready") throw new Error("Repository index not ready after polling. Try again shortly.");
        } else if (info.state === "building") {
          if (needsBranch) {
            return {
              content: [{ type: "text", text: `Index still building for ${searchOwner}/${searchRepo}. Try again in a minute.` }],
              details: { state: info.state, branch },
            };
          }
          info = await waitForIndex(searchOwner, searchRepo, token, combined, pollAttempts);
          if (info.state !== "ready") throw new Error("Repository index not ready after polling. Try again shortly.");
        }

        const pathFilters = coerceStringArray(params.path);
        const langFilters = coerceStringArray(params.lang);
        // Repo-only scoping + client prefix filter (path:/lang: in scoping_query 404s on some private repos).
        const apiPath = pathFilters?.length ? undefined : pathFilters;
        const apiLang = pathFilters?.length ? undefined : langFilters;
        let results = await search(searchOwner, searchRepo, params.query, token, combined, apiPath, apiLang, {
          maxResults,
          embeddingModel,
        });
        results = filterResultsByPathPrefix(results, pathFilters);
        const deduped = dedupeAndFilter(results);
        const output = format(deduped, parsed.owner, parsed.repo, branch);
        const branchLabel = branch ? ` @ ${branch}` : "";
        const suffix = deduped.length === 1 ? " result" : " results";
        const title =
          results.length === deduped.length
            ? `Searched ${parsed.owner}/${parsed.repo}${branchLabel} for "${params.query}" — ${results.length}${suffix}`
            : `Searched ${parsed.owner}/${parsed.repo}${branchLabel} for "${params.query}" — ${results.length} raw, ${deduped.length} after quality filter`;
        pi.logger.info(title);
        return { content: [{ type: "text", text: output }], details: { title, count: deduped.length } };
      } catch (err) {
        if (isAbortError(err, combined)) {
          return {
            content: [{ type: "text", text: "Search was aborted due to timeout. Try a more specific query." }],
            details: { aborted: true },
          };
        }
        throw err;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("githubrepo omp extension loaded", "info");
  });
}
