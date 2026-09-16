/** 社内マニュアルAI. Access must protect this Worker and /api/* (all traffic). */
import type { Env, ChatMessage } from "./types";
import { groundedStream, record, SYSTEM_PROMPT } from "./grounding";

const MAX_BODY_BYTES = 524288;
const MAX_MESSAGES = 20;
const MAX_QUESTION = 1000;

class InputError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: {
    "cache-control": "no-store", "x-content-type-options": "nosniff",
  } });
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new InputError(415, "JSON形式で送信してください。");
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES)
    throw new InputError(413, "送信内容が大きすぎます。会話をクリアして再度お試しください。");
  if (!request.body) throw new InputError(400, "質問を入力してください。");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "", size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new InputError(413, "送信内容が大きすぎます。会話をクリアしてください。");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(text); } catch { throw new InputError(400, "送信内容を確認してください。"); }
}

/** Discard old assistant replies: a previous generic answer is NOT a manual. */
export function manualMessages(body: unknown): ChatMessage[] {
  if (!record(body) || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > MAX_MESSAGES)
    throw new InputError(400, "質問を入力してください。会話が長い場合はクリアしてください。");
  const questions: string[] = [];
  for (const msg of body.messages) {
    if (!record(msg) || (msg.role !== "user" && msg.role !== "assistant") || typeof msg.content !== "string")
      throw new InputError(400, "送信内容を確認してください。");
    if (msg.role === "user") {
      const text = msg.content.trim();
      if (!text || text.length > MAX_QUESTION) throw new InputError(400, "質問は1〜1000文字で入力してください。");
      questions.push(text);
    }
  }
  if (body.messages[body.messages.length - 1].role !== "user" || !questions.length)
    throw new InputError(400, "質問を入力してください。");
  const latest = questions.pop()!;
  const previous = questions.slice(-3);
  const query = previous.length
    ? `過去の質問は話題の理解にだけ使ってください。社内ルールの根拠ではありません。\n過去の質問: ${JSON.stringify(previous)}\n\n今回回答する質問:\n${latest}`
    : latest;
  return [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: query }];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname !== "/api/chat") return jsonError(404, "ページが見つかりません。");
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
    // Not a replacement for Access/JWT validation. Reject cross-origin browser writes.
    const origin = request.headers.get("origin");
    if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site")
      return jsonError(403, "このページから質問を送信してください。");
    try {
      const messages = manualMessages(await readBody(request));
      // NO AI.run(), generic fallback, external model, or browser-supplied model/system prompt.
      const upstream = await env.AI.chatCompletions({
        messages, stream: true,
        ai_search_options: {
          retrieval: { max_num_results: 8, metadata_only: false, return_on_failure: false },
          query_rewrite: { enabled: true },
          // Avoid cached completions created before the manual-only prompt was applied.
          cache: { enabled: false },
        },
      });
      return new Response(groundedStream(upstream, request.signal), { headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store", "x-content-type-options": "nosniff",
        "x-manual-ai-version": "manual-only-20260917",
      } });
    } catch (error) {
      if (error instanceof InputError) return jsonError(error.status, error.message);
      console.error("MANUAL_AI: AI Search request failed");
      return jsonError(502, "マニュアルを検索できませんでした。時間をおいて再度お試しください。");
    }
  },
};
