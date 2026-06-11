#!/bin/sh
set -e

# Ensure Claude CLI config directory exists with correct permissions
if [ ! -d "/home/aboardai/.claude" ]; then
    mkdir -p /home/aboardai/.claude
fi

# If CLAUDE_OAUTH_CREDENTIALS is set, write it to the credentials file
# This allows passing OAuth tokens from host (especially macOS where they're in Keychain)
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ]; then
    echo "$CLAUDE_OAUTH_CREDENTIALS" > /home/aboardai/.claude/.credentials.json
    chmod 600 /home/aboardai/.claude/.credentials.json
fi

# Fix permissions on Claude CLI config directory
chown -R aboardai:aboardai /home/aboardai/.claude
chmod 700 /home/aboardai/.claude

# Ensure Cursor CLI config directory exists with correct permissions
# This handles both: mounted volumes (owned by root) and empty directories
if [ ! -d "/home/aboardai/.cursor" ]; then
    mkdir -p /home/aboardai/.cursor
fi
chown -R aboardai:aboardai /home/aboardai/.cursor
chmod -R 700 /home/aboardai/.cursor

# Ensure OpenCode CLI config directory exists with correct permissions
# OpenCode stores config and auth in ~/.local/share/opencode/
if [ ! -d "/home/aboardai/.local/share/opencode" ]; then
    mkdir -p /home/aboardai/.local/share/opencode
fi
chown -R aboardai:aboardai /home/aboardai/.local/share/opencode
chmod -R 700 /home/aboardai/.local/share/opencode

# OpenCode also uses ~/.config/opencode for configuration
if [ ! -d "/home/aboardai/.config/opencode" ]; then
    mkdir -p /home/aboardai/.config/opencode
fi
chown -R aboardai:aboardai /home/aboardai/.config/opencode
chmod -R 700 /home/aboardai/.config/opencode

# OpenCode also uses ~/.cache/opencode for cache data (version file, etc.)
if [ ! -d "/home/aboardai/.cache/opencode" ]; then
    mkdir -p /home/aboardai/.cache/opencode
fi
chown -R aboardai:aboardai /home/aboardai/.cache/opencode
chmod -R 700 /home/aboardai/.cache/opencode

# Ensure npm cache directory exists with correct permissions
# This is needed for using npx to run MCP servers
if [ ! -d "/home/aboardai/.npm" ]; then
    mkdir -p /home/aboardai/.npm
fi
chown -R aboardai:aboardai /home/aboardai/.npm

# If CURSOR_AUTH_TOKEN is set, write it to the cursor auth file
# On Linux, cursor-agent uses ~/.config/cursor/auth.json for file-based credential storage
# The env var CURSOR_AUTH_TOKEN is also checked directly by cursor-agent
if [ -n "$CURSOR_AUTH_TOKEN" ]; then
    CURSOR_CONFIG_DIR="/home/aboardai/.config/cursor"
    mkdir -p "$CURSOR_CONFIG_DIR"
    # Write auth.json with the access token
    cat > "$CURSOR_CONFIG_DIR/auth.json" << EOF
{
  "accessToken": "$CURSOR_AUTH_TOKEN"
}
EOF
    chmod 600 "$CURSOR_CONFIG_DIR/auth.json"
    chown -R aboardai:aboardai /home/aboardai/.config
fi

# Switch to aboardai user and execute the command
exec gosu aboardai "$@"
