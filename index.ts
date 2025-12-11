import { serve } from "bun";

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SERVER_API_KEY;
const TARGET_URL = "https://longcat.chat/api/v1/chat-completion-oversea";

// --- Debug ---
const DEBUG = true; // Set false khi chạy production để bớt rác log
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
  "m-appkey": process.env.LONGCAT_APPKEY || "fe_com.sankuai.friday.fe.longcat",
  "m-traceid": process.env.LONGCAT_TRACEID || "-5919502901649396665",
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
  "x-requested-with": "XMLHttpRequest" 
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

function generateMsgId() {
  return Math.floor(10000000 + Math.random() * 90000000);
}

// --- Payload Transformer ---
function transformPayload(reqBody: any) {
  const lastMessage = reqBody.messages[reqBody.messages.length - 1];
  const modelName = reqBody.model ? reqBody.model.toLowerCase() : "longcat-flash";
  
  const isThinking = modelName.includes("think") || modelName.includes("reason");
  const isSearch = modelName.includes("search") || modelName.includes("online");

  const userMsgId = generateMsgId();
  const assistantMsgId = generateMsgId();

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
        messageId: userMsgId,
        idType: "custom"
      },
      {
        role: "assistant",
        events: [],
        chatStatus: "LOADING",
        messageId: assistantMsgId,
        idType: "custom"
      }
    ],
    reasonEnabled: isThinking ? 1 : 0,
    searchEnabled: isSearch ? 1 : 0,
    regenerate: 0
  };
}

// --- Server Logic ---
const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" } });
    }

    if (url.pathname === "/v1/models") {
      return new Response(JSON.stringify({ object: "list", data: AVAILABLE_MODELS }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

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

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No body");
        const decoder = new TextDecoder();

        // --- XỬ LÝ STREAM (Chế độ gõ chữ) ---
        if (isStream) {
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const chatId = generateId();

          (async () => {
            try {
              let buffer = "";
              let lastContent = ""; 
              let lastThinking = "";

              // Initial Chunk
              await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({
                  id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
                  choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
              })}\n\n`));

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
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

                      let deltaPayload: any = {};
                      let hasUpdate = false;

                      // 1. Content
                      if (event.type === "content" && typeof event.content === "string") {
                          const fullContent = event.content;
                          let delta = "";
                          if (fullContent.length < lastContent.length) lastContent = "";
                          if (fullContent.startsWith(lastContent)) delta = fullContent.substring(lastContent.length);
                          else delta = fullContent;
                          
                          if (delta) {
                              lastContent = fullContent;
                              deltaPayload = { content: delta };
                              hasUpdate = true;
                          }
                      }
                      // 2. Think
                      else if (event.type === "think" && typeof event.content === "string") {
                          const fullThinking = event.content;
                          let delta = "";
                          if (fullThinking.length < lastThinking.length) lastThinking = "";
                          if (fullThinking.startsWith(lastThinking)) delta = fullThinking.substring(lastThinking.length);
                          else delta = fullThinking;

                          if (delta) {
                              lastThinking = fullThinking;
                              deltaPayload = { reasoning_content: delta };
                              hasUpdate = true;
                          }
                      }
                      // 3. Search
                      else if (event.type === "search" && event.content) {
                           // (Logic search giống cũ)
                           const searchContent = event.content;
                           let searchLog = "";
                           if (searchContent.query) searchLog = `\n🔍 **Searching:** *${searchContent.query}*\n\n`;
                           else if (Array.isArray(searchContent.resultList)) {
                               searchContent.resultList.slice(0,5).forEach((item:any, idx:number) => {
                                   searchLog += `> ${idx+1}. [${item.title}](${item.url})\n`;
                               });
                               searchLog += "\n---\n\n";
                           }
                           if (searchLog) {
                               deltaPayload = { reasoning_content: searchLog };
                               hasUpdate = true;
                           }
                      }
                      // 4. Finish
                      else if (event.type === "finish") {
                        await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({
                            id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
                            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                        })}\n\n`));
                        await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
                        return;
                      }

                      if (hasUpdate) {
                          await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({
                            id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
                            choices: [{ index: 0, delta: deltaPayload, finish_reason: null }]
                          })}\n\n`));
                      }
                    } catch (e) {}
                  }
                }
              }
            } catch (err) {
              log("STREAM_ERR", err);
            } finally {
              await writer.close();
            }
          })();

          return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" } });
        } 
        
        // --- XỬ LÝ NON-STREAM (Chế độ chờ trả hết) ---
        else {
            let buffer = "";
            let finalContent = "";
            let finalThinking = "";
            let searchLogs = "";

            log("NON_STREAM", "Accumulating response...");

            // Vòng lặp đọc hết Stream từ Longcat
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
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

                            // Cập nhật nội dung mới nhất
                            if (event.type === "content" && typeof event.content === "string") {
                                finalContent = event.content;
                            }
                            if (event.type === "think" && typeof event.content === "string") {
                                finalThinking = event.content;
                            }
                            if (event.type === "search" && event.content) {
                                if (event.content.query) {
                                    searchLogs += `🔍 Searching: ${event.content.query}\n`;
                                } else if (Array.isArray(event.content.resultList)) {
                                     event.content.resultList.slice(0,3).forEach((item:any, i:number) => {
                                         searchLogs += `[${i+1}] ${item.title} (${item.url})\n`;
                                     });
                                     searchLogs += "\n";
                                }
                            }
                        } catch (e) {}
                    }
                }
            }
            
            log("NON_STREAM", "Done. Sending JSON.");

            // Ghép Search vào Reasoning nếu có
            if (searchLogs) {
                finalThinking = searchLogs + "\n" + finalThinking;
            }

            return new Response(JSON.stringify({
                id: generateId(),
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: finalContent || "", // Đảm bảo không undefined
                        reasoning_content: finalThinking || null // DeepSeek style
                    },
                    finish_reason: "stop"
                }],
                usage: {
                    prompt_tokens: 0,
                    completion_tokens: finalContent.length,
                    total_tokens: finalContent.length
                }
            }), {
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
            });
        }

      } catch (error) {
        log("INTERNAL_ERR", error);
        return createErrorResponse(500, "Internal Server Error");
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🦊 Bun Proxy (All Modes) running on http://localhost:${PORT}`);
