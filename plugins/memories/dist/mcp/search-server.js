import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_MEMORY_VERSION } from "../shared/constants/version.js";
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const RECALL_TOOL_NAME = "recall";
const SERVER_INFO = {
  name: "memories",
  version: CLAUDE_MEMORY_VERSION
};
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function toJsonRpcId(value) {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }
  return null;
}
function createErrorResponse(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}
function createResultResponse(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}
function resolveProtocolVersion(message) {
  const params = message["params"];
  if (!isRecord(params)) {
    return DEFAULT_PROTOCOL_VERSION;
  }
  const protocolVersion = params["protocolVersion"];
  return typeof protocolVersion === "string" ? protocolVersion : DEFAULT_PROTOCOL_VERSION;
}
function listToolsResult() {
  return {
    tools: [
      {
        name: RECALL_TOOL_NAME,
        description: "Search memories for the current active memory space. This rebuild stub is not implemented yet.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              minLength: 1
            }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    ]
  };
}
function callToolResult(message) {
  const params = message["params"];
  if (!isRecord(params) || params["name"] !== RECALL_TOOL_NAME) {
    return createErrorResponse(
      toJsonRpcId(message["id"]),
      -32602,
      `Unknown tool. Expected "${RECALL_TOOL_NAME}".`
    );
  }
  return createResultResponse(toJsonRpcId(message["id"]), {
    content: [
      {
        type: "text",
        text: "Claude Memory recall is not implemented yet in this rebuild."
      }
    ],
    isError: true
  });
}
function handleJsonRpcMessage(message) {
  if (!isRecord(message)) {
    return createErrorResponse(null, -32600, "Invalid JSON-RPC request.");
  }
  const id = toJsonRpcId(message["id"]);
  const method = message["method"];
  if (typeof method !== "string") {
    return createErrorResponse(id, -32600, "Invalid JSON-RPC request.");
  }
  if (message["jsonrpc"] !== "2.0") {
    return createErrorResponse(id, -32600, 'Expected jsonrpc to equal "2.0".');
  }
  if (message["id"] === void 0) {
    return null;
  }
  if (method === "initialize") {
    return createResultResponse(id, {
      protocolVersion: resolveProtocolVersion(message),
      capabilities: {
        tools: {}
      },
      serverInfo: SERVER_INFO
    });
  }
  if (method === "ping") {
    return createResultResponse(id, {});
  }
  if (method === "tools/list") {
    return createResultResponse(id, listToolsResult());
  }
  if (method === "tools/call") {
    return callToolResult(message);
  }
  return createErrorResponse(id, -32601, `Method "${method}" is not supported.`);
}
function serializeJsonRpcMessage(message) {
  const bodyText = JSON.stringify(message);
  const contentLength = Buffer.byteLength(bodyText, "utf8");
  return `Content-Length: ${String(contentLength)}\r
\r
${bodyText}`;
}
function consumeFrameBuffer(frameBuffer) {
  let remainingBuffer = frameBuffer;
  const messages = [];
  for (; ; ) {
    const headerEndIndex = remainingBuffer.indexOf("\r\n\r\n");
    if (headerEndIndex < 0) {
      return { remainingBuffer, messages };
    }
    const headerText = remainingBuffer.subarray(0, headerEndIndex).toString("utf8");
    const contentLengthMatch = /(?:^|\r\n)Content-Length:\s*(?<length>\d+)(?:\r\n|$)/iu.exec(headerText);
    const contentLengthText = contentLengthMatch?.groups?.["length"];
    if (!contentLengthText) {
      throw new Error("Missing Content-Length header.");
    }
    const contentLength = Number.parseInt(contentLengthText, 10);
    const bodyStartIndex = headerEndIndex + 4;
    const bodyEndIndex = bodyStartIndex + contentLength;
    if (remainingBuffer.length < bodyEndIndex) {
      return { remainingBuffer, messages };
    }
    const bodyText = remainingBuffer.subarray(bodyStartIndex, bodyEndIndex).toString(
      "utf8"
    );
    messages.push(JSON.parse(bodyText));
    remainingBuffer = remainingBuffer.subarray(bodyEndIndex);
  }
}
function writeResponse(response) {
  process.stdout.write(serializeJsonRpcMessage(response));
}
function startMcpServer() {
  let frameBuffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    frameBuffer = Buffer.concat([frameBuffer, chunkBuffer]);
    try {
      const consumedFrameResult = consumeFrameBuffer(frameBuffer);
      frameBuffer = consumedFrameResult.remainingBuffer;
      for (const message of consumedFrameResult.messages) {
        const response = handleJsonRpcMessage(message);
        if (response) {
          writeResponse(response);
        }
      }
    } catch (error) {
      frameBuffer = Buffer.alloc(0);
      writeResponse(
        createErrorResponse(
          null,
          -32700,
          error instanceof Error ? error.message : "Invalid JSON-RPC payload."
        )
      );
    }
  });
  process.stdin.resume();
}
function isMainModule() {
  const invokedPath = process.argv[1];
  if (!invokedPath) {
    return false;
  }
  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}
if (isMainModule()) {
  startMcpServer();
}
export {
  handleJsonRpcMessage,
  serializeJsonRpcMessage,
  startMcpServer
};
