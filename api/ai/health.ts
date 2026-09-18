/**
 * GET /api/ai/health — is the assistant configured, and can it be reached?
 *
 * Answers without a key present (reporting `configured: false`) so a
 * deployment can be diagnosed before anything works. `?probe=1` spends one
 * tiny real generation to prove the credential is accepted end-to-end;
 * without it the check is free, because an uptime monitor polling every
 * minute should not be able to burn the hotel's token budget.
 *
 * The public answer is only `{ status, provider, configured }`, where status
 * is "ok", "not_configured" or "unreachable" (503 unless ok). The model id,
 * latency and failure reason are operator detail: they go to the log, never
 * into the response, and the key appears in neither.
 */
import { checkHealth } from "../../server/ai/provider.js";
import { enforceRateLimit } from "../../server/ai/rateLimit.js";
import { errorMessage, isAiError } from "../../server/ai/errors.js";
import {
  applyCors,
  clientKey,
  handlePreflight,
  newRequestId,
  requireMethod,
  sendJson,
  type ApiRequest,
  type ApiResponse,
} from "../../server/ai/http.js";

/** A probe costs a model call, so it is limited harder than a plain check. */
const PROBE_RATE_LIMIT = { limit: 6, windowMs: 60_000 };

function wantsProbe(req: ApiRequest): boolean {
  // Parsed from the raw URL rather than a framework's `query`, so this
  // handler keeps working unchanged on a plain Node server.
  const url = (req as { url?: string }).url ?? "";
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return false;

  const value = new URLSearchParams(url.slice(queryStart + 1)).get("probe");
  return value === "1" || value === "true";
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (!requireMethod(req, res, "GET")) return;

  const requestId = newRequestId();
  const probe = wantsProbe(req);

  try {
    if (probe) enforceRateLimit(`health:${clientKey(req)}`, PROBE_RATE_LIMIT);

    const report = await checkHealth({ probe });

    // A configured-but-unreachable assistant is a real failure, and a
    // monitor should see it as one rather than a 200 with a flag inside.
    const healthy = report.configured && (!probe || report.reachable === true);
    const status = healthy ? "ok" : report.configured ? "unreachable" : "not_configured";
    // The public body is deliberately minimal: provider, configured, status.
    // The model, latency and failure reason are operator detail, logged only.
    if (!healthy) console.warn("[health] not ok", { requestId, ...report });
    sendJson(res, healthy ? 200 : 503, { status, provider: report.provider, configured: report.configured });
  } catch (error) {
    console.error("[health] failed", {
      requestId,
      code: isAiError(error) ? error.code : "unexpected",
      detail: errorMessage(error),
    });
    sendJson(res, isAiError(error) ? error.status : 500, { status: "error", provider: null, configured: false });
  }
}
