#!/usr/bin/env tsx

import 'dotenv/config';
import { $ } from 'zx';

interface MCPConfig {
  command: string;
  args: string[];
}

async function setupMCPPostgres(): Promise<void> {
  // Get DATABASE_URL from environment
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('❌ DATABASE_URL not found in environment variables');
    console.error('Please ensure you have a .env file with DATABASE_URL defined');
    process.exit(1);
  }

  console.log('📦 Configuring MCP Postgres server...');
  // Hide password in output
  const maskedUrl = databaseUrl.replace(/:[^:@]+@/, ':****@');
  console.log(`🔗 Using database: ${maskedUrl}`);

  try {
    // Build the configuration object
    const config: MCPConfig = {
      command: "npx",
      args: ["@modelcontextprotocol/server-postgres", databaseUrl]
    };
    
    // Run the claude mcp command
    await $`claude mcp add-json postgres ${JSON.stringify(config)}`;
    
    console.log('✅ MCP Postgres server configured successfully!');
    console.log('You can now use the postgres server in Claude.');
  } catch (error) {
    console.error('❌ Failed to configure MCP server:', (error as Error).message);
    process.exit(1);
  }
}

// Run the setup
setupMCPPostgres().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});