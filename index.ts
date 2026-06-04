import { serve } from "bun";

// ============================================================
// Configuration
// ============================================================
const PORT = parseInt(process.env.PORT || "3000");
const API_KEY = process.env.SERVER_API_KEY;
const TARGET_URL = "https://longcat.chat/api/v1/chat-completion-oversea";
const UPSTREAM_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT || "30000");

// Guest mode: cookie is optional. Longcat API works without authentication.
const USER_COOKIE = process.env.LONGCAT_COOKIE || "";
const APPKEY = process.env.LONGCAT_APPKEY || "fe_com.sankuai.friday.fe.longcat";
const TRACEID = process.env.LONGCAT_TRACEID || `-${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

// ============================================================
// Header Builder (cookie optional for guest mode)
// ============================================================
function buildHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "authority": "longcat.chat",
    "accept": "text/event-stream,application/json",
    "accept-language": "vi-VN,vi;q=0.9",
    "content-type": "application/json",
    "m-appkey": APPKEY,
    "m-traceid": TRACEID,
    "origin": "https://longcat.chat",
    "referer": "https://longcat.chat/t",
    "sec-ch-ua": '"Chromium";v="137", "Not/A)Brand";v="24"',
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
    "x-client-language": "en",
    "x-requested-with": "XMLHttpRequest",
  };
  if (cookie) {
    headers["cookie"] = cookie;
  }
  return headers;
}

// ============================================================
// Model Discovery (auto-fetch from longcat API)
// ============================================================
let discoveredModel: string | null = null;
let discoveryAttempted = false;

async function discoverModel(): Promise<string> {
  if (discoveredModel) return discoveredModel;
  if (discoveryAttempted) return "LongCat-2.0-Preview";
  discoveryAttempted = true;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const payload = {
      content: "hi",
      agentId: "1",
      messages: [
        {
          role: "user",
          events: [{ type: "userMsg", content: "hi", status: "FINISHED" }],
          chatStatus: "FINISHED",
          messageId: 10000001,
          idType: "custom",
        },
        {
          role: "assistant",
          events: [],
          chatStatus: "LOADING",
          messageId: 10000002,
          idType: "custom",
        },
      ],
      reasonEnabled: 0,
      searchEnabled: 0,
      regenerate: 0,
    };

    const res = await fetch(TARGET_URL, {
      method: "POST",
      headers: buildHeaders(USER_COOKIE),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No body");
    const decoder = new TextDecoder();
    let buffer = "";

    // Read first few chunks to extract model name from SSE data
    for (let i = 0; i < 8; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim().startsWith("data:")) {
          try {
            const data = JSON.parse(line.replace("data:", "").trim());
            if (data.model) {
              discoveredModel = data.model;
              reader.cancel();
              console.log(`[longcat2api] Discovered model: ${discoveredModel}`);
              return discoveredModel;
            }
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
    reader.cancel();
  } catch (err) {
    console.warn(`[longcat2api] Model discovery failed: ${err}`);
  }

  console.log(`[longcat2api] Using default model: LongCat-2.0-Preview`);
  return "LongCat-2.0-Preview";
}

// ============================================================
// Model List Builder (dynamic from discovered model)
// ============================================================
function buildModelsList(baseModel: string): Array<{
  id: string;
  object: string;
  created: number;
  owned_by: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const name = baseModel || "LongCat-2.0-Preview";
  return [
    {
      id: "longcat-flash",
      object: "model",
      created: now,
      owned_by: "longcat",
    },
    {
      id: "longcat-thinking",
      object: "model",
      created: now,
      owned_by: "longcat",
    },
    {
      id: "longcat-search",
      object: "model",
      created: now,
      owned_by: "longcat",
    },
    {
      id: "longcat-pro",
      object: "model",
      created: now,
      owned_by: "longcat",
    },
    {
      id: name.toLowerCase().replace(/\s+/g, "-"),
      object: "model",
      created: now,
      owned_by: "longcat",
    },
  ];
}

// ============================================================
// Helpers
// ============================================================
function createErrorResponse(status: number, message: string) {
  return new Response(
    JSON.stringify({ error: { message, type: "server_error" } }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

function generateId(): string {
  return `chatcmpl-${Math.random().toString(36).substring(2, 10)}`;
}

function generateMsgId(): number {
  return Math.floor(10000000 + Math.random() * 90000000);
}

// ============================================================
// Payload Transformer
// ============================================================
function transformPayload(reqBody: any) {
  const messages = reqBody.messages || [];
  const lastMessage = messages[messages.length - 1] || { content: "" };
  const modelName = (reqBody.model || "longcat-flash").toLowerCase();

  const isThinking =
    modelName.includes("think") || modelName.includes("reason");
  const isSearch = modelName.includes("search") || modelName.includes("online");
  const isPro = modelName === "longcat-pro";

  const userMsgId = generateMsgId();
  const assistantMsgId = generateMsgId();

  return {
    content: lastMessage.content || "",
    agentId: isPro ? "2" : "1",
    messages: [
      {
        role: "user",
        events: [
          {
            type: "userMsg",
            content: lastMessage.content || "",
            status: "FINISHED",
          },
        ],
        chatStatus: "FINISHED",
        messageId: userMsgId,
        idType: "custom",
      },
      {
        role: "assistant",
        events: [],
        chatStatus: "LOADING",
        messageId: assistantMsgId,
        idType: "custom",
      },
    ],
    reasonEnabled: isThinking ? 1 : 0,
    searchEnabled: isSearch ? 1 : 0,
    regenerate: 0,
  };
}

// ============================================================
// Stream Handler
// ============================================================
async function handleStream(
  upstreamReader: ReadableStreamDefaultReader<Uint8Array>,
  model: string,
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const chatId = generateId();
  const decoder = new TextDecoder();

  // Start stream with role chunk
  const initialChunk = {
    id: chatId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ],
  };
  writer.write(
    new TextEncoder().encode(`data: ${JSON.stringify(initialChunk)}\n\n`),
  );

  // Process upstream SSE stream asynchronously
  (async () => {
    try {
      let buffer = "";
      let lastContent = "";
      let lastThinking = "";

      while (true) {
        const { done, value } = await upstreamReader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim().startsWith("data:")) continue;

          const jsonStr = line.replace("data:", "").trim();
          if (!jsonStr) continue;

          try {
            const data = JSON.parse(jsonStr);
            const event = data.event;
            if (!event) continue;

            let deltaPayload: any = {};
            let hasUpdate = false;

            if (event.type === "content" && typeof event.content === "string") {
              const fullContent = event.content;
              let delta = "";
              if (fullContent.length < lastContent.length) lastContent = "";
              if (fullContent.startsWith(lastContent))
                delta = fullContent.substring(lastContent.length);
              else delta = fullContent;
              if (delta) {
                lastContent = fullContent;
                deltaPayload = { content: delta };
                hasUpdate = true;
              }
            } else if (
              event.type === "think" &&
              typeof event.content === "string"
            ) {
              const fullThinking = event.content;
              let delta = "";
              if (fullThinking.length < lastThinking.length)
                lastThinking = "";
              if (fullThinking.startsWith(lastThinking))
                delta = fullThinking.substring(lastThinking.length);
              else delta = fullThinking;
              if (delta) {
                lastThinking = fullThinking;
                deltaPayload = { reasoning_content: delta };
                hasUpdate = true;
              }
            } else if (event.type === "search" && event.content) {
              const searchContent = event.content;
              let searchLog = "";
              if (searchContent.query) {
                searchLog = `\n🔍 **Searching:** *${searchContent.query}*\n\n`;
              } else if (Array.isArray(searchContent.resultList)) {
                searchContent.resultList
                  .slice(0, 5)
                  .forEach((item: any, idx: number) => {
                    const snippet = item.snippet
                      ? ` - *"${item.snippet.substring(0, 50)}..."*`
                      : "";
                    searchLog += `> ${idx + 1}. [${item.title || "Link"}](${item.url})${snippet}\n`;
                  });
                searchLog += "\n---\n\n";
              }
              if (searchLog) {
                deltaPayload = { reasoning_content: searchLog };
                hasUpdate = true;
              }
            } else if (event.type === "finish") {
              const finishChunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  { index: 0, delta: {}, finish_reason: "stop" },
                ],
              };
              await writer.write(
                new TextEncoder().encode(
                  `data: ${JSON.stringify(finishChunk)}\n\n`,
                ),
              );
              await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
              return;
            }

            if (hasUpdate) {
              const deltaChunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  { index: 0, delta: deltaPayload, finish_reason: null },
                ],
              };
              await writer.write(
                new TextEncoder().encode(
                  `data: ${JSON.stringify(deltaChunk)}\n\n`,
                ),
              );
            }
          } catch {
            // skip malformed JSON in stream
          }
        }
      }
    } catch (err) {
      console.error(`[longcat2api] Stream error: ${err}`);
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ============================================================
// Non-Stream Handler
// ============================================================
async function handleNonStream(
  upstreamReader: ReadableStreamDefaultReader<Uint8Array>,
  model: string,
): Promise<Response> {
  const decoder = new TextDecoder();
  let buffer = "";
  let finalContent = "";
  let finalThinking = "";
  let searchLogs = "";

  while (true) {
    const { done, value } = await upstreamReader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim().startsWith("data:")) continue;

      const jsonStr = line.replace("data:", "").trim();
      if (!jsonStr) continue;

      try {
        const data = JSON.parse(jsonStr);
        const event = data.event;
        if (!event) continue;

        if (event.type === "content" && typeof event.content === "string") {
          finalContent = event.content;
        }
        if (event.type === "think" && typeof event.content === "string") {
          finalThinking = event.content;
        }
        if (event.type === "search" && event.content) {
          if (event.content.query) {
            searchLogs += `> 🔍 **Searching:** *${event.content.query}*\n\n`;
          } else if (Array.isArray(event.content.resultList)) {
            searchLogs += `> **Search Results:**\n`;
            event.content.resultList
              .slice(0, 5)
              .forEach((item: any, i: number) => {
                const snippet = item.snippet
                  ? ` - "${item.snippet.substring(0, 100)}..."`
                  : "";
                searchLogs += `> ${i + 1}. [${item.title}](${item.url})${snippet}\n`;
              });
            searchLogs += "\n---\n";
          }
        }
      } catch {
        // skip malformed JSON
      }
    }
  }

  const combinedReasoning =
    (searchLogs ? searchLogs + "\n" : "") + finalThinking;

  return new Response(
    JSON.stringify({
      id: generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: finalContent || "",
            ...(combinedReasoning
              ? { reasoning_content: combinedReasoning }
              : {}),
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: finalContent.length,
        total_tokens: finalContent.length,
      },
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

// ============================================================
// Main — Discovery then Serve
// ============================================================
async function main() {
  // Step 1: Discover model from upstream (non-blocking for startup)
  const baseModel = await discoverModel();
  let modelsCache = buildModelsList(baseModel);

  console.log(`🦊 Bun Longcat Proxy running on http://localhost:${PORT}`);
  console.log(`[longcat2api] Base model: ${baseModel}`);
  console.log(
    `[longcat2api] Mode: ${USER_COOKIE ? "authenticated" : "guest (no cookie needed)"}`,
  );
  console.log(`[longcat2api] Models: ${modelsCache.map((m) => m.id).join(", ")}`);

  // Step 2: Start server
  serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "*",
          },
        });
      }

      // GET /v1/models — return dynamic model list
      if (url.pathname === "/v1/models") {
        return new Response(
          JSON.stringify({ object: "list", data: modelsCache }),
          {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      // POST /v1/chat/completions — proxy to longcat
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return createErrorResponse(400, "Invalid JSON body");
        }

        // Optional API key check
        if (API_KEY) {
          const authHeader = req.headers.get("authorization") || "";
          if (!authHeader.includes(API_KEY)) {
            return createErrorResponse(401, "Invalid API key");
          }
        }

        try {
          const longcatPayload = transformPayload(body);
          const isStream = body.stream === true;
          const model = body.model || "longcat-flash";

          // Upstream request with timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            UPSTREAM_TIMEOUT,
          );

          const response = await fetch(TARGET_URL, {
            method: "POST",
            headers: buildHeaders(USER_COOKIE),
            body: JSON.stringify(longcatPayload),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            let userMessage = `Upstream error (${response.status})`;
            try {
              const errJson = JSON.parse(errorText);
              if (errJson.message) userMessage = errJson.message;
            } catch {
              if (errorText) userMessage = errorText.slice(0, 200);
            }
            return createErrorResponse(response.status, userMessage);
          }

          const reader = response.body?.getReader();
          if (!reader) throw new Error("No response body from upstream");

          if (isStream) {
            return handleStream(reader, model);
          } else {
            return handleNonStream(reader, model);
          }
        } catch (err: any) {
          if (err.name === "AbortError") {
            return createErrorResponse(
              504,
              "Upstream request timed out",
            );
          }
          console.error(`[longcat2api] Proxy error: ${err}`);
          return createErrorResponse(502, "Upstream request failed");
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}

main().catch((err) => {
  console.error(`[longcat2api] Fatal error: ${err}`);
  process.exit(1);
});
