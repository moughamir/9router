import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

let initialized = false;

/**
 * Unauthenticated chat completion endpoint.
 * Only active when BYPASS_AUTH=true — otherwise the route is hidden (404).
 * API key validation is skipped even when settings.requireApiKey is enabled.
 */
const bypassAuthEnabled = () => process.env.BYPASS_AUTH === "true";

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {
  if (!bypassAuthEnabled()) {
    return errorResponse(HTTP_STATUS.NOT_FOUND, "Not found");
  }

  await ensureInitialized();

  return await handleChat(request, null, { skipAuth: true });
}