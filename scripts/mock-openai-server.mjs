import http from "node:http";

const port = Number(process.env.PORT || 11434);

const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Not found" } }));
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    try {
      const payload = JSON.parse(body);
      const userMessage = payload.messages?.find(
        (message) => message.role === "user"
      );
      const input = JSON.parse(userMessage?.content || "{}");
      const translations = (input.segments || []).map((segment) => ({
        id: segment.id,
        text: `测试译文：${segment.text}`
      }));
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({ translations })
              }
            }
          ]
        })
      );
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: error.message } })
      );
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock OpenAI API listening on http://127.0.0.1:${port}/v1`);
});
