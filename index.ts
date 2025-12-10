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

// --- Available Models (Official Only) ---
const AVAILABLE_MODELS = [
  {
    id: "longcat-flash",
    object: "model",
    created: 1700000000,
    owned_by: "longcat",
    permission: [],
    root: "longcat-flash",
    parent: null,
  },
  {
    id: "longcat-thinking",
    object: "model",
    created: 1700000000,
    owned_by: "longcat",
    permission: [],
    root: "longcat-thinking", // Triggers Reasoning features
    parent: null,
  },
  {
    id: "longcat-search",
    object: "model",
    created: 1700000000,
    owned_by: "longcat",
    permission: [],
    root: "longcat-search", // Triggers Web Search features
    parent: null,
  }
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

// --- Transformer: OpenAI Messages -> Longcat Payload ---
function transformPayload(reqBody: OpenAIRequest) {
  const lastMessage = reqBody.messages[reqBody.messages.length - 1];
  const modelName = reqBody.model.toLowerCase();
  
  // Logic mapping model name -> Feature flags
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

    // 1. CORS Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        },
      });
    }

    // 2. Auth Check (Skip for root)
    const authHeader = req.headers.get("Authorization");
    const isAuth = !API_KEY || (authHeader && authHeader.replace("Bearer ", "") === API_KEY);

    // 3. Routes
    
    // GET / (Health)
    if (url.pathname === "/") return new Response("Longcat OpenAI Proxy 🚀");

    // GET /v1/models (List Models)
    if (url.pathname === "/v1/models" && req.method === "GET") {
      if (!isAuth) return createErrorResponse(401, "Invalid API Key");
      
      return new Response(JSON.stringify({
        object: "list",
        data: AVAILABLE_MODELS
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // POST /v1/chat/completions (Chat)
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

                      // A. Search -> Reasoning
                      if (event.type === "search" && event.content) {
                          const searchContent = event.content;
                          let searchLog = "";
                          if (searchContent.query) {
                              searchLog = `\n> 🔍 **Searching:** ${searchContent.query}\n\n`;
                          } else if (Array.isArray(searchContent.resultList)) {
                              searchContent.resultList.slice(0, 5).forEach((item: any, idx: number) => {
                                  searchLog += `> ${idx + 1}. [${item.title}](${item.url})\n`;
                              });
                              searchLog += "\n";
                          }
                          if (searchLog) {
                              deltaPayload = { reasoning_content: searchLog };
                              hasUpdate = true;
                          }
                      }
                      // B. Thinking -> Reasoning
                      else if (event.type === "think" && event.content) {
                          const delta = event.content.startsWith(lastThinking) 
                              ? event.content.substring(lastThinking.length) 
                              : event.content;
                          if (delta) {
                              lastThinking = event.content;
                              deltaPayload = { reasoning_content: delta };
                              hasUpdate = true;
                          }
                      }
                      // C. Content
                      else if (event.type === "content" && event.content) {
                          const delta = event.content.startsWith(lastContent) 
                              ? event.content.substring(lastContent.length) 
                              : event.content;
                          if (delta) {
                              lastContent = event.content;
                              deltaPayload = { content: delta };
                              hasUpdate = true;
                          }
                      }
                      // D. Finish
                      else if (event.type === "finish") {
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
                    } catch (e) {}
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
        
        // --- Non-Stream Handling ---
        else {
          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          let fullResponseText = "";
          
          if (reader) {
             while (true) {
               const { done, value } = await reader.read();
               if (done) break;
               const chunkStr = decoder.decode(value);
               const lines = chunkStr.split("\n");
               for (const line of lines) {
                  if (line.trim().startsWith("data:")) {
                     try {
                       const data = JSON.parse(line.replace("data:", "").trim());
                       if (data.event?.type === "content") fullResponseText = data.event.content;
                     } catch(e) {}
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
              message: { role: "assistant", content: fullResponseText },
              finish_reason: "stop"
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
        }

      } catch (error) {
        return createErrorResponse(500, "Internal Server Error");
      }
    }

    return createErrorResponse(404, "Not Found");
  },
});

console.log(`🦊 Bun Longcat Proxy running on http://localhost:${PORT}`);
