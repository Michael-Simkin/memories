import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const RECALL_TOOL_NAME = "recall";
const SERVER_INFO = {
  name: "memories",
  version: "0.0.0",
};

type JsonRpcId = number | string | null;

interface JsonRpcErrorObject {
  code: number;
  message: string;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

interface JsonRpcResultResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

type JsonRpcResponse = JsonRpcErrorResponse | JsonRpcResultResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toJsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }

  return null;
}

function createErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function createResultResponse(
  id: JsonRpcId,
  result: unknown,
): JsonRpcResultResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function resolveProtocolVersion(message: Record<string, unknown>): string {
  const params = message["params"];

  if (!isRecord(params)) {
    return DEFAULT_PROTOCOL_VERSION;
  }

  const protocolVersion = params["protocolVersion"];

  return typeof protocolVersion === "string"
    ? protocolVersion
    : DEFAULT_PROTOCOL_VERSION;
}

function listToolsResult(): { tools: Array<Record<string, unknown>> } {
  return {
    tools: [
      {
        name: RECALL_TOOL_NAME,
        description:
          "Search memories for the current active memory space. This rebuild stub is not implemented yet.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              minLength: 1,
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
  };
}

function callToolResult(message: Record<string, unknown>): JsonRpcResponse {
  const params = message["params"];

  if (!isRecord(params) || params["name"] !== RECALL_TOOL_NAME) {
    return createErrorResponse(
      toJsonRpcId(message["id"]),
      -32602,
      `Unknown tool. Expected "${RECALL_TOOL_NAME}".`,
    );
  }

  return createResultResponse(toJsonRpcId(message["id"]), {
    content: [
      {
        type: "text",
        text: "Claude Memory recall is not implemented yet in this rebuild.",
      },
    ],
    isError: true,
  });
}

export function handleJsonRpcMessage(message: unknown): JsonRpcResponse | null {
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

  if (message["id"] === undefined) {
    return null;
  }

  if (method === "initialize") {
    return createResultResponse(id, {
      protocolVersion: resolveProtocolVersion(message),
      capabilities: {
        tools: {},
      },
      serverInfo: SERVER_INFO,
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

export function serializeJsonRpcMessage(message: JsonRpcResponse): string {
  const bodyText = JSON.stringify(message);
  const contentLength = Buffer.byteLength(bodyText, "utf8");

  return `Content-Length: ${String(contentLength)}\r\n\r\n${bodyText}`;
}

function consumeFrameBuffer(
  frameBuffer: Buffer,
): { remainingBuffer: Buffer; messages: unknown[] } {
  let remainingBuffer = frameBuffer;
  const messages: unknown[] = [];

  for (;;) {
    const headerEndIndex = remainingBuffer.indexOf("\r\n\r\n");

    if (headerEndIndex < 0) {
      return { remainingBuffer, messages };
    }

    const headerText = remainingBuffer.subarray(0, headerEndIndex).toString("utf8");
    const contentLengthMatch =
      /(?:^|\r\n)Content-Length:\s*(?<length>\d+)(?:\r\n|$)/iu.exec(headerText);
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
      "utf8",
    );

    messages.push(JSON.parse(bodyText));
    remainingBuffer = remainingBuffer.subarray(bodyEndIndex);
  }
}

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(serializeJsonRpcMessage(response));
}

export function startMcpServer(): void {
  let frameBuffer = Buffer.alloc(0) as Buffer;

  process.stdin.on("data", (chunk: Buffer | string) => {
    const chunkBuffer =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);

    frameBuffer = Buffer.concat([frameBuffer, chunkBuffer]) as Buffer;

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
          error instanceof Error ? error.message : "Invalid JSON-RPC payload.",
        ),
      );
    }
  });

  process.stdin.resume();
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];

  if (!invokedPath) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  startMcpServer();
}
