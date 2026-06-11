/**
 * Configuration fixtures for testing
 */

export const tomlConfigFixture = `
experimental_use_rmcp_client = true

[mcp_servers.aboardai-tools]
command = "node"
args = ["/path/to/server.js"]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled_tools = ["UpdateFeatureStatus"]

[mcp_servers.aboardai-tools.env]
ABOARDAI_PROJECT_PATH = "/path/to/project"
`;
