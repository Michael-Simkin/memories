import path from "node:path";
import { fileURLToPath } from "node:url";

import type { z } from "zod";

import {
  DEFAULT_ENGINE_REQUEST_TIMEOUT_MS,
  postEngineJson,
} from "../engine/engine-client.js";
import {
  ensureEngine,
  type EnsureEngineOptions,
} from "../engine/ensure-engine.js";
import { CLAUDE_MEMORY_VERSION } from "../shared/constants/version.js";
import { currentContextSchema } from "../shared/schemas/space.js";
import type { MemorySearchResponse } from "../shared/types/memory.js";
import { recallToolArgumentsSchema } from "./schemas/recall.js";

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const RECALL_TOOL_NAME = "recall";
const SERVER_INFO = {
  name: "memories",
  version: CLAUDE_MEMORY_VERSION,
};

type JsonRpcId = number | string | null;
type RecallToolArguments = z.infer<typeof recallToolArgumentsSchema>;

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

interface SearchServerOptions extends EnsureEngineOptions {
  requestTimeoutMs?: number | undefined;
}

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

function createToolTextResult(
  id: JsonRpcId,
  text: string,
  isError = false,
): JsonRpcResultResponse {
  return createResultResponse(id, {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError,
  });
}

function resolveProtocolVersion(message: Record<string, unknown>): string {
  const params = message["params"];

  if (!isRecord(params)) {
    return DEFAULT_PROTOCOL_VERSION;
  }

  const protocolVersion = params["protocolVersion"];

  if (typeof protocolVersion === "string") {
    return protocolVersion;
  }

  return DEFAULT_PROTOCOL_VERSION;
}

function listToolsResult(): { tools: Array<Record<string, unknown>> } {
  return {
    tools: [
      {
        name: RECALL_TOOL_NAME,
        description:
          "Use `recall` before acting on non-trivial work, and use it again when project context changes. Pinned startup context is only a subset. This searches only the current active memory space.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              minLength: 1,
            },
            related_paths: {
              type: "array",
              items: {
                type: "string",
                minLength: 1,
              },
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
  };
}

function formatSpaceMetadata(space: MemorySearchResponse["space"]): string[] {
  const lines = [
    `Active space kind: \`${space.space_kind}\``,
    `Active space: \`${space.space_display_name}\``,
  ];

  if (space.origin_url_normalized) {
    lines.push(`Normalized origin: \`${space.origin_url_normalized}\``);
  }

  return lines;
}

function buildRecallMarkdown(
  searchResponse: MemorySearchResponse,
  arguments_: RecallToolArguments,
): string {
  const lines = [
    "# Claude Memory Recall",
    "",
    `Query: \`${arguments_.query}\``,
    ...formatSpaceMetadata(searchResponse.space),
    "",
  ];

  if (searchResponse.results.length === 0) {
    lines.push("_No matching memories found in the current active space._");
    return lines.join("\n");
  }

  lines.push("## Results", "");

  searchResponse.results.forEach((result, index) => {
    lines.push(
      `### ${String(index + 1)}. \`${result.memory_type}\` via ${result.matched_by
        .map((matchedBy) => `\`${matchedBy}\``)
        .join(", ")}`,
    );
    lines.push(result.content);

    if (result.tags.length > 0) {
      lines.push("", `Tags: ${result.tags.map((tag) => `\`${tag}\``).join(", ")}`);
    }

    if (result.path_matchers.length > 0) {
      lines.push(
        "",
        `Path matchers: ${result.path_matchers
          .map((matcher) => `\`${matcher}\``)
          .join(", ")}`,
      );
    }

    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

async function callToolResult(
  message: Record<string, unknown>,
  options: SearchServerOptions,
): Promise<JsonRpcResponse> {
  const params = message["params"];

  if (!isRecord(params) || params["name"] !== RECALL_TOOL_NAME) {
    return createErrorResponse(
      toJsonRpcId(message["id"]),
      -32602,
      `Unknown tool. Expected "${RECALL_TOOL_NAME}".`,
    );
  }

  const parsedArguments = recallToolArgumentsSchema.safeParse(params["arguments"]);

  if (!parsedArguments.success) {
    const firstIssue = parsedArguments.error.issues[0];

    return createErrorResponse(
      toJsonRpcId(message["id"]),
      -32602,
      firstIssue?.message ?? "Invalid recall arguments.",
    );
  }

  try {
    const currentContext = currentContextSchema.parse({
      project_root: process.env["CLAUDE_PROJECT_DIR"],
      cwd: process.cwd(),
    });
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_ENGINE_REQUEST_TIMEOUT_MS;
    const ensuredEngine = await ensureEngine(options);
    const searchResponse = await postEngineJson<MemorySearchResponse>(
      ensuredEngine.connection,
      "/memories/search",
      {
        context: currentContext,
        query: parsedArguments.data.query,
        related_paths: parsedArguments.data.related_paths,
      },
      requestTimeoutMs,
    );

    return createToolTextResult(
      toJsonRpcId(message["id"]),
      buildRecallMarkdown(searchResponse, parsedArguments.data),
    );
  } catch (error) {
    return createToolTextResult(
      toJsonRpcId(message["id"]),
      `Claude Memory recall failed: ${
        error instanceof Error ? error.message : "Unknown recall error."
      }`,
      true,
    );
  }
}

export async function handleJsonRpcMessage(
  message: unknown,
  options: SearchServerOptions = {},
): Promise<JsonRpcResponse | null> {
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
    return callToolResult(message, options);
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

export function startMcpServer(options: SearchServerOptions = {}): void {
  let frameBuffer: Buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk: Buffer | string) => {
    void (async () => {
      const chunkBuffer =
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);

      frameBuffer = Buffer.concat([frameBuffer, chunkBuffer]);

      try {
        const consumedFrameResult = consumeFrameBuffer(frameBuffer);
        frameBuffer = consumedFrameResult.remainingBuffer;

        for (const message of consumedFrameResult.messages) {
          const response = await handleJsonRpcMessage(message, options);

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
    })();
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
