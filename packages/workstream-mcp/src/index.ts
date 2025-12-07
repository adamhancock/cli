#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getCookies, type GetCookiesInput } from './tools/get-cookies.js';
import { getRecentRequests, type GetRequestsInput } from './tools/get-requests.js';
import { getLocalStorage, type GetLocalStorageInput } from './tools/get-localstorage.js';
import { getConsoleLogs, type GetConsoleLogsInput } from './tools/get-console-logs.js';
import { generateCurl, type GenerateCurlInput } from './tools/generate-curl.js';
import { closeRedisConnection } from './redis-client.js';

const server = new Server(
  {
    name: 'workstream-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_cookies',
        description:
          'Get cookies stored by the Workstream Chrome extension. Returns cookies for tracked development domains that can be used for authenticated API requests.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: {
              type: 'string',
              description: 'Optional domain filter (e.g., "dev.localhost")',
            },
            name: {
              type: 'string',
              description: 'Optional cookie name to retrieve (e.g., "session", "auth_token")',
            },
          },
        },
      },
      {
        name: 'get_recent_requests',
        description:
          'Get recent HTTP requests logged by the Workstream Chrome extension. Useful for investigating API calls, debugging, and understanding application behavior.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: {
              type: 'string',
              description: 'Filter by domain (e.g., "dev.localhost")',
            },
            port: {
              type: 'number',
              description: 'Filter by destination port (e.g., 3000, 8080)',
            },
            method: {
              type: 'string',
              description: 'Filter by HTTP method (GET, POST, PUT, DELETE, etc.)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of requests to return (default: 100, max: 1000)',
            },
            statusCode: {
              type: 'number',
              description: 'Filter by HTTP status code (e.g., 200, 404, 500)',
            },
            path: {
              type: 'string',
              description: 'Filter by URL path (e.g., "/api/users", "/graphql")',
            },
            type: {
              type: 'string',
              description: 'Filter by resource type (e.g., "xhr", "fetch", "document", "script", "stylesheet")',
            },
          },
        },
      },
      {
        name: 'get_localstorage',
        description:
          'Get localStorage data stored by the Workstream Chrome extension. Returns localStorage key-value pairs for tracked development domains.',
        inputSchema: {
          type: 'object',
          properties: {
            origin: {
              type: 'string',
              description: 'Optional origin filter (e.g., "http://dev.localhost:3000")',
            },
            key: {
              type: 'string',
              description: 'Optional key to retrieve a specific localStorage item',
            },
          },
        },
      },
      {
        name: 'get_console_logs',
        description: 'Get console output captured via the Workstream Chrome extension for tracked domains.',
        inputSchema: {
          type: 'object',
          properties: {
            origin: {
              type: 'string',
              description: 'Optional origin filter (e.g., "http://dev.localhost:3000")',
            },
            level: {
              type: 'string',
              enum: ['log', 'info', 'warn', 'error', 'debug'],
              description: 'Filter by console level',
            },
            search: {
              type: 'string',
              description: 'Filter messages by text appearing in args, stack, or URL',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of logs to return (default: 100, max: 500)',
            },
          },
        },
      },
      {
        name: 'generate_curl',
        description:
          'Generate a curl command with authentication cookies from the Workstream Chrome extension. Use this to make authenticated API requests to development environments.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to request',
            },
            method: {
              type: 'string',
              description: 'HTTP method (default: GET)',
            },
            includeAuth: {
              type: 'boolean',
              description: 'Include authentication cookies (default: true)',
            },
            headers: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Additional headers to include',
            },
            data: {
              type: 'string',
              description: 'Request body data',
            },
          },
          required: ['url'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_cookies': {
        const input = (args ?? {}) as GetCookiesInput;
        const result = await getCookies(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_recent_requests': {
        const input = (args ?? {}) as GetRequestsInput;
        const result = await getRecentRequests(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_localstorage': {
        const input = (args ?? {}) as GetLocalStorageInput;
        const result = await getLocalStorage(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_console_logs': {
        const input = (args ?? {}) as GetConsoleLogsInput;
        const result = await getConsoleLogs(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'generate_curl': {
        const input = args as unknown as GenerateCurlInput;
        if (!input?.url) {
          throw new Error('url is required');
        }
        const result = await generateCurl(input);
        return {
          content: [
            {
              type: 'text',
              text: `Generated curl command:\n\n${result.curl}\n\nCookies used: ${result.cookiesUsed.length > 0 ? result.cookiesUsed.join(', ') : 'none'}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

// Cleanup on exit
process.on('SIGINT', async () => {
  await closeRedisConnection();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeRedisConnection();
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Workstream MCP] Server started');
}

main().catch((error) => {
  console.error('[Workstream MCP] Fatal error:', error);
  process.exit(1);
});
