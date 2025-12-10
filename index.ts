import { serve } from "bun";

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SERVER_API_KEY;
const TARGET_URL = "https://longcat.chat/api/v1/chat-completion-oversea";

// --- Debug Configuration ---
const DEBUG = true; // Bật cờ này để xem log

function log(tag: string, ...args: any[]) {
  if (DEBUG) {
    const time = new Date().toISOString().split("T")[1].replace("Z", "");
    console.log(`[${time}][${tag}]`, ...args);
  }
}

// --- Headers ---
const HEADERS = {
  "authority": "longcat.chat",
  "accept": "text/event-stream,application/json",
  "accept-language": "vi-VN,vi;q=0.9",
  "content-type": "application/json",
  "cookie": process.env.LONGCAT_COOKIE || "",
  "m-appkey": process.env.LONGCAT_APPKEY || "",
  "m-traceid": process.env.LONGCAT_TRACEID || "",
  "origin": "https://longcat.chat",
  "referer": "https://longcat.chat/t",
  "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

const AVAILABLE_MODELS = [
  { id: "longcat-flash", object: "model", created: 1700000000, owned_by: "longcat" },
  { id: "longcat-thinking", object: "model", created: 1700000000, owned_by: "longcat" },
  { id: "longcat-search", object: "model", created: 1700000000, owned_by: "longcat" }
];

// --- Helpers ---
function createErrorResponse(status: number, message: string) {
  log("ERROR", `Status: ${status} | Msg: ${message}`);
  return new Response(JSON.stringify({ error: { message, type: "server_error" } }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function generateId() {
  return `chatcmpl-${Math.random().toString(36).substring(2, 10)}`;
}

function transformPayload(reqBody: any) {
  const lastMessage = reqBody.messages[reqBody.messages.length - 1];
  const modelName = reqBody.model ? reqBody.model.toLowerCase() : "longcat-flash";
  
  const isThinking = modelName.includes("think") || modelName.includes("reason");
  const isSearch = modelName.includes("search") || modelName.includes("online");

  return {
    content: lastMessage.content || "",
    agentId: "1",
    messages: [
      {
        role: "user",
        events: [
          { type: "userMsg", content: lastMessage.content || "", status: "FINISHED" }
        ],
        chatStatus: "FINISHED",
        messageId: Date.now(),
        idType: "custom"
      }
    ],
    reasonEnabled: isThinking ? 1 : 0,
    searchEnabled: isSearch ? 1 : 0,
    regenerate: 0
  };
}

// --- Server ---
const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        },
      });
    }

    // Models Endpoint
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return new Response(JSON.stringify({ object: "list", data: AVAILABLE_MODELS }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // Chat Endpoint
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const longcatPayload = transformPayload(body);
        const isStream = body.stream === true;
        const model = body.model || "longcat-flash"; 

        log("REQ", `Model: ${model} | Stream: ${isStream}`);

        const response = await fetch(TARGET_URL, {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify(longcatPayload),
        });

        if (!response.ok) {
          const text = await response.text();
          log("UPSTREAM_FAIL", `${response.status} - ${text.substring(0, 100)}`);
          return createErrorResponse(response.status, `Upstream Error: ${response.statusText}`);
        }

        if (isStream) {
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          const chatId = generateId();

          (async () => {
            try {
              const reader = response.body?.getReader();
              if (!reader) throw new Error("No body");

              let buffer = "";
              let lastContent = ""; 
              let lastThinking = "";

              // Send Initial Chunk
              const startChunk = {
                  id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
                  choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
              };
              await writer.write(encoder.encode(`data: ${JSON.stringify(startChunk)}\n\n`));
              log("STREAM", "Started - Sent Initial Chunk");

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunkText = decoder.decode(value, { stream: true });
                buffer += chunkText;
                const lines = buffer.split("\n");
                buffer = lines.pop() || ""; 

                for (const line of lines) {
                  if (line.trim().startsWith("data:")) {
                    const jsonStr = line.replace("data:", "").trim();
                    if (!jsonStr) continue;

                    try {
                      const data = JSON.parse(jsonStr);
                      const event = data.event;
                      if (!event) continue;

                      // Log Raw Event để debug
                      // log("RAW_EVENT", `${event.type} -> ContentLen: ${event.content ? event.content.length : 0}`);

                      let deltaPayload: any = {};
                      let hasUpdate = false;

                      // === LOGIC TÍNH DELTA ===
                      
                      // 1. Content
                      if (event.type === "content") {
                          const fullContent = event.content || "";
                          let delta = "";
                          
                          // Log logic tính toán
                          // log("CALC", `Last: ${lastContent.length} | New: ${fullContent.length}`);

                          if (fullContent.length < lastContent.length) {
                             log("RESET", "New content shorter than old content. Resetting.");
                             lastContent = "";
                          }

                          if (fullContent.startsWith(lastContent)) {
                              delta = fullContent.substring(lastContent.length);
                          } else {
                              // Nếu không khớp prefix, có thể server đã sửa lại câu. Gửi lại phần khác biệt hoặc gửi hết.
                              log("MISMATCH", "Content prefix mismatch. Sending full as delta (risky).");
                              delta = fullContent; // Fallback
                          }

                          if (delta) {
                              lastContent = fullContent;
                              deltaPayload = { content: delta };
                              hasUpdate = true;
                              // log("DELTA_OUT", delta);
                          }
                      }

                      // 2. Thinking
                      else if (event.type === "think") {
                          const fullThinking = event.content || "";
                          let delta = "";
                          
                          if (fullThinking.length < lastThinking.length) lastThinking = "";

                          if (fullThinking.startsWith(lastThinking)) {
                              delta = fullThinking.substring(lastThinking.length);
                          } else {
                              delta = fullThinking;
                          }

                          if (delta) {
                              lastThinking = fullThinking;
                              deltaPayload = { reasoning_content: delta };
                              hasUpdate = true;
                          }
                      }
                      
                      // 3. Search
                      else if (event.type === "search" && event.content) {
                          // ... (Search logic keep same)
                          const searchContent = event.content;
                          let searchLog = "";
                          if (searchContent.query) searchLog = `\n🔍 **Searching:** ${searchContent.query}\n\n`;
                          else if (Array.isArray(searchContent.resultList)) {
                              searchContent.resultList.slice(0,3).forEach((i:any, idx:number) => searchLog += `> ${idx+1}. [${i.title}](${i.url})\n`);
                              searchLog += "\n---\n";
                          }
                          if (searchLog) {
                              deltaPayload = { reasoning_content: searchLog };
                              hasUpdate = true;
                              log("SEARCH", "Found search event");
                          }
                      }

                      // 4. Finish
                      else if (event.type === "finish") {
                        log("STREAM", "Received FINISH event");
                        const endChunk = {
                            id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
                            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                        };
                        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
                        await writer.write(encoder.encode("data: [DONE]\n\n"));
                        return;
                      }

                      if (hasUpdate) {
                          const chunk = {
                            id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
                            choices: [{ index: 0, delta: deltaPayload, finish_reason: null }]
                          };
                          await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                      }

                    } catch (e) {
                      log("PARSE_ERR", jsonStr.substring(0, 50));
                    }
                  }
                }
              }
            } catch (err) {
              log("STREAM_ERR", err);
            } finally {
              log("STREAM", "Closed");
              await writer.close();
            }
          })();

          return new Response(readable, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" },
          });
        }
        
        // Non-stream fallback (bỏ qua cho gọn để tập trung debug stream)
        return new Response(JSON.stringify({choices:[]}));

      } catch (error) {
        log("INTERNAL_ERR", error);
        return createErrorResponse(500, "Internal Server Error");
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🦊 DEBUG Proxy running on http://localhost:${PORT}`);
