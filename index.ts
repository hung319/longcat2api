import { serve } from "bun";

// --- Types ---
interface OpenAIMessage {
  role: string;
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
}

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SERVER_API_KEY;
const TARGET_URL = "https://longcat.chat/api/v1/chat-completion-oversea";

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
  { id: "longcat-flash", object: "model", created: 1700000000, owned_by: "longcat", permission: [], root: "longcat-flash", parent: null },
  { id: "longcat-thinking", object: "model", created: 1700000000, owned_by: "longcat", permission: [], root: "longcat-thinking", parent: null },
  { id: "longcat-search", object: "model", created: 1700000000, owned_by: "longcat", permission: [], root: "longcat-search", parent: null }
];

// --- Helpers ---
function createErrorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message, type: "server_error" } }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function generateId() {
  return `chatcmpl-${Math.random().toString(36).substring(2, 10)}`;
}

// --- Payload Transformer ---
function transformPayload(reqBody: OpenAIRequest) {
  const lastMessage = reqBody.messages[reqBody.messages.length - 1];
  const modelName = reqBody.model.toLowerCase();
  
  const isThinking = modelName.includes("think") || modelName.includes("reason");
  const isSearch = modelName.includes("search") || modelName.includes("online");

  return {
    content: lastMessage.content || "",
    agentId: "1",
    messages: [
      {
        role: "user",
        events: [
          {
            type: "userMsg",
            content: lastMessage.content || "",
            status: "FINISHED"
          }
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

// --- Core Server Logic ---
const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. CORS
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        },
      });
    }

    const authHeader = req.headers.get("Authorization");
    const isAuth = !API_KEY || (authHeader && authHeader.replace("Bearer ", "") === API_KEY);

    // 2. Routes
    if (url.pathname === "/") return new Response("Longcat Proxy Fixed 🛠️");

    if (url.pathname === "/v1/models" && req.method === "GET") {
      if (!isAuth) return createErrorResponse(401, "Invalid API Key");
      return new Response(JSON.stringify({ object: "list", data: AVAILABLE_MODELS }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      if (!isAuth) return createErrorResponse(401, "Invalid API Key");

      try {
        const body = await req.json() as OpenAIRequest;
        const longcatPayload = transformPayload(body);
        const isStream = body.stream === true;
        const model = body.model || "longcat-flash"; 

        console.log(`[Proxy] Model: ${model} | Stream: ${isStream} | R: ${longcatPayload.reasonEnabled} | S: ${longcatPayload.searchEnabled}`);

        const response = await fetch(TARGET_URL, {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify(longcatPayload),
        });

        if (!response.ok) {
          console.error(`Upstream Error: ${response.status} - ${await response.text()}`);
          return createErrorResponse(response.status, `Upstream Error: ${response.statusText}`);
        }

        // --- Stream Handling ---
        if (isStream) {
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          const chatId = generateId();

          (async () => {
            try {
              const reader = response.body?.getReader();
              if (!reader) throw new Error("No response body");

              let buffer = "";
              let lastContent = ""; 
              let lastThinking = "";
              
              // Gửi chunk mở đầu để Client biết kết nối OK
              const startChunk = {
                  id: chatId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
              };
              await writer.write(encoder.encode(`data: ${JSON.stringify(startChunk)}\n\n`));

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
                      
                      // Debug log nhẹ để xem sự kiện gì đang về
                      // console.log("Event Type:", event.type); 

                      let deltaPayload: any = {};
                      let hasUpdate = false;

                      // 1. Handle Content (Standard Chat)
                      // Fix: Kiểm tra typeof string thay vì check truthy để ko bỏ qua chuỗi rỗng
                      if (event.type === "content" && typeof event.content === "string") {
                          const fullContent = event.content;
                          let delta = "";

                          // Reset nếu nội dung mới ngắn hơn (rewrite)
                          if (fullContent.length < lastContent.length) {
                              lastContent = ""; 
                          }

                          if (fullContent.startsWith(lastContent)) {
                              delta = fullContent.substring(lastContent.length);
                          } else {
                              delta = fullContent; // Fallback
                          }

                          if (delta) {
                              lastContent = fullContent;
                              deltaPayload = { content: delta };
                              hasUpdate = true;
                          }
                      }

                      // 2. Handle Thinking (If reasoning enabled)
                      else if (event.type === "think" && typeof event.content === "string") {
                          const fullThinking = event.content;
                          let delta = "";
                          
                           if (fullThinking.length < lastThinking.length) {
                              lastThinking = "";
                          }

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

                      // 3. Handle Search
                      else if (event.type === "search" && event.content) {
                          const searchContent = event.content;
                          let searchLog = "";

                          if (searchContent.query) {
                              searchLog = `\n> 🔍 **Searching:** *${searchContent.query}*\n\n`;
                          } else if (Array.isArray(searchContent.resultList)) {
                               searchContent.resultList.slice(0, 5).forEach((item: any, idx: number) => {
                                  const snippet = item.snippet ? ` - *"${item.snippet.substring(0, 80)}..."*` : "";
                                  searchLog += `> ${idx + 1}. [${item.title || "Link"}](${item.url})${snippet}\n`;
                              });
                              searchLog += "\n---\n\n";
                          }
                          if (searchLog) {
                              deltaPayload = { reasoning_content: searchLog }; // Đẩy vào reasoning để không lẫn vào nội dung chính
                              hasUpdate = true;
                          }
                      }

                      // 4. Handle Finish
                      else if (event.type === "finish") {
                        // Gửi tín hiệu dừng
                         const endChunk = {
                          id: chatId,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: model,
                          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                        };
                        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
                        await writer.write(encoder.encode("data: [DONE]\n\n"));
                        return;
                      }

                      // Gửi Data về Client
                      if (hasUpdate) {
                          const chunk = {
                            id: chatId,
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: model,
                            choices: [{ index: 0, delta: deltaPayload, finish_reason: null }]
                          };
                          await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                      }

                    } catch (e) {
                         // console.error("Parse Error:", e);
                    }
                  }
                }
              }
            } catch (err) {
              console.error("Stream Error:", err);
            } finally {
              await writer.close();
            }
          })();

          return new Response(readable, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" },
          });
        } 
        
        // --- Non-Stream Handling (Simplified) ---
        else {
            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let fullResponseText = "";
            let fullReasoningText = "";
            
            if (reader) {
                while(true) {
                    const {done, value} = await reader.read();
                    if(done) break;
                    const lines = decoder.decode(value).split("\n");
                    for(const line of lines) {
                        if(line.startsWith("data:")) {
                            try {
                                const data = JSON.parse(line.replace("data:", "").trim());
                                if(data.event?.type === "content") fullResponseText = data.event.content;
                                if(data.event?.type === "think") fullReasoningText = data.event.content;
                            } catch(e){}
                        }
                    }
                }
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
                        content: fullResponseText,
                        reasoning_content: fullReasoningText
                    }, 
                    finish_reason: "stop" 
                }]
             }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
        }

      } catch (error) {
        console.error("Internal Error:", error);
        return createErrorResponse(500, "Internal Server Error");
      }
    }

    return createErrorResponse(404, "Not Found");
  },
});

console.log(`🦊 Bun Longcat Proxy Fixed running on http://localhost:${PORT}`);
