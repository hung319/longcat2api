import { serve } from "bun";

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SERVER_API_KEY;
const TARGET_URL = "https://longcat.chat/api/v1/chat-completion-oversea";

// --- Debug ---
const DEBUG = true;
function log(tag: string, ...args: any[]) {
  if (DEBUG) {
    const time = new Date().toISOString().split("T")[1].replace("Z", "");
    console.log(`[${time}][${tag}]`, ...args);
  }
}

// --- Headers (Match exactly with CURL) ---
const HEADERS = {
  "authority": "longcat.chat",
  "accept": "text/event-stream,application/json",
  "accept-language": "vi-VN,vi;q=0.9",
  "content-type": "application/json",
  // Cookie lấy từ env, nếu user quên set thì để rỗng (sẽ lỗi auth)
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
  // Hai header này cực kỳ quan trọng, thiếu là bị đóng kết nối
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

// Generate random 8-digit integer ID like "32509700"
function generateMsgId() {
  return Math.floor(10000000 + Math.random() * 90000000);
}

// --- Payload Transformer (Strict Match CURL) ---
function transformPayload(reqBody: any) {
  const lastMessage = reqBody.messages[reqBody.messages.length - 1];
  const modelName = reqBody.model ? reqBody.model.toLowerCase() : "longcat-flash";
  
  const isThinking = modelName.includes("think") || modelName.includes("reason");
  const isSearch = modelName.includes("search") || modelName.includes("online");

  // Giả lập 2 ID ngẫu nhiên
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
      // Placeholder Assistant (Bắt buộc)
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

        log("REQ", `Model: ${model} | Stream: ${isStream} | Sending to Longcat...`);
        // Debug payload gửi đi
        // log("PAYLOAD", JSON.stringify(longcatPayload));

        const response = await fetch(TARGET_URL, {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify(longcatPayload),
        });

        log("RESP", `Status: ${response.status} | Content-Type: ${response.headers.get("content-type")}`);

        if (!response.ok) {
          const text = await response.text();
          log("UPSTREAM_FAIL", `${response.status} - ${text.substring(0, 200)}`);
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
              await writer.write(encoder.encode(`data: ${JSON.stringify({
                  id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
                  choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
              })}\n\n`));
              
              log("STREAM", "Connected, waiting for events...");

              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    log("STREAM", "Upstream closed connection");
                    break;
                }

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
                      
                      // Log để debug xem có nhận được data thật không
                      // if (event) log("EVENT_RX", event.type);

                      if (!event) continue;

                      let deltaPayload: any = {};
                      let hasUpdate = false;

                      // 1. Content Logic
                      if (event.type === "content" && typeof event.content === "string") {
                          const fullContent = event.content;
                          let delta = "";
                          
                          if (fullContent.length < lastContent.length) lastContent = "";

                          if (fullContent.startsWith(lastContent)) {
                              delta = fullContent.substring(lastContent.length);
                          } else {
                              delta = fullContent; 
                          }

                          if (delta) {
                              lastContent = fullContent;
                              deltaPayload = { content: delta };
                              hasUpdate = true;
                          }
                      }

                      // 2. Thinking Logic
                      else if (event.type === "think" && typeof event.content === "string") {
                          const fullThinking = event.content;
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

                      // 3. Search Logic
                      else if (event.type === "search" && event.content) {
                          const searchContent = event.content;
                          let searchLog = "";
                          if (searchContent.query) searchLog = `\n🔍 **Searching:** *${searchContent.query}*\n\n`;
                          else if (Array.isArray(searchContent.resultList)) {
                              searchContent.resultList.slice(0,5).forEach((item: any, idx: number) => {
                                  const snippet = item.snippet ? ` - *"${item.snippet.substring(0, 60)}..."*` : "";
                                  searchLog += `> ${idx + 1}. [${item.title || "Link"}](${item.url})${snippet}\n`;
                              });
                              searchLog += "\n---\n\n";
                          }
                          if (searchLog) {
                              deltaPayload = { reasoning_content: searchLog };
                              hasUpdate = true;
                              log("SEARCH", "Results processed");
                          }
                      }

                      // 4. Finish Logic
                      else if (event.type === "finish") {
                        log("STREAM", "Finished [DONE]");
                        await writer.write(encoder.encode(`data: ${JSON.stringify({
                            id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
                            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                        })}\n\n`));
                        await writer.write(encoder.encode("data: [DONE]\n\n"));
                        return;
                      }

                      if (hasUpdate) {
                          await writer.write(encoder.encode(`data: ${JSON.stringify({
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
              log("STREAM", "Writer closed");
              await writer.close();
            }
          })();

          return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" } });
        }
        
        return new Response(JSON.stringify({choices:[]}));

      } catch (error) {
        log("INTERNAL_ERR", error);
        return createErrorResponse(500, "Internal Server Error");
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🦊 Bun Proxy (Clone CURL) running on http://localhost:${PORT}`);
