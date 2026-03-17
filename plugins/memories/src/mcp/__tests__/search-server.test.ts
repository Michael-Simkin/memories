import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CLAUDE_MEMORY_VERSION } from "../../shared/constants/version.js";
import {
  handleJsonRpcMessage,
  serializeJsonRpcMessage,
} from "../search-server.js";

describe("search-server", () => {
  it("initializes with the requested MCP protocol version", () => {
    const response = handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
      },
    });

    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "memories",
          version: CLAUDE_MEMORY_VERSION,
        },
      },
    });
  });

  it("lists the recall tool", () => {
    const response = handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: "recall",
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
      },
    });
  });

  it("returns a stub error result for recall until the rebuild wires real search", () => {
    const response = handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "recall",
        arguments: {
          query: "search docs",
        },
      },
    });

    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [
          {
            type: "text",
            text: "Claude Memory recall is not implemented yet in this rebuild.",
          },
        ],
        isError: true,
      },
    });
  });

  it("returns a JSON-RPC error for unknown methods", () => {
    const response = handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/unknown",
    });

    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 4,
      error: {
        code: -32601,
        message: 'Method "tools/unknown" is not supported.',
      },
    });
  });

  it("serializes JSON-RPC responses with Content-Length framing", () => {
    const serializedMessage = serializeJsonRpcMessage({
      jsonrpc: "2.0",
      id: 5,
      result: {
        ok: true,
      },
    });

    assert.match(serializedMessage, /^Content-Length: \d+\r\n\r\n/u);
    assert.match(serializedMessage, /"jsonrpc":"2\.0"/u);
    assert.match(serializedMessage, /"id":5/u);
    assert.match(serializedMessage, /"ok":true/u);
  });
});
