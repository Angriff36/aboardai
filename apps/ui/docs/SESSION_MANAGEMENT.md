# Session management

AboardAI agent chat supports multiple persistent sessions. Sessions are owned by the Express backend and are available to both the browser and Electron UI.

## Capabilities

- Create sessions with a name and optional project path, working directory, and model.
- Switch between sessions without combining their histories.
- Rename sessions, change tags or model metadata, archive and unarchive them, or delete them.
- Queue prompts while a session is processing.
- Reload message history from disk after a renderer reload or application restart.

Deleting a session is destructive: it removes the session’s stored conversation history and metadata. Archiving is the reversible option for hiding inactive sessions.

## Storage

`AgentService` stores session data under the configured `DATA_DIR`:

```text
DATA_DIR/
  sessions-metadata.json
  agent-sessions/
    <session-id>.json
```

In normal repository development, `DATA_DIR` defaults to `./data`. Packaged Electron builds use Electron’s user-data directory. The production Docker compose file uses `/data` backed by the `aboardai-data` named volume.

Session metadata includes the session name, timestamps, project or working-directory association, archive state, tags, and selected model where present. Conversation files contain the message history used to continue the chat.

## HTTP API

Session metadata routes are mounted under `/api/sessions`:

| Method   | Route                                | Purpose                          |
| -------- | ------------------------------------ | -------------------------------- |
| `GET`    | `/api/sessions`                      | List active sessions             |
| `GET`    | `/api/sessions?includeArchived=true` | Include archived sessions        |
| `POST`   | `/api/sessions`                      | Create a session                 |
| `PUT`    | `/api/sessions/:sessionId`           | Update name, tags, or model      |
| `POST`   | `/api/sessions/:sessionId/archive`   | Archive a session                |
| `POST`   | `/api/sessions/:sessionId/unarchive` | Restore an archived session      |
| `DELETE` | `/api/sessions/:sessionId`           | Delete a session and its history |

Agent interaction routes are mounted under `/api/agent`:

| Method | Route                | Purpose                                    |
| ------ | -------------------- | ------------------------------------------ |
| `POST` | `/api/agent/start`   | Start a session run                        |
| `POST` | `/api/agent/send`    | Send a prompt or attachment paths          |
| `POST` | `/api/agent/history` | Load history                               |
| `POST` | `/api/agent/stop`    | Stop the current run                       |
| `POST` | `/api/agent/clear`   | Clear conversation state                   |
| `POST` | `/api/agent/model`   | Change the session model                   |
| `POST` | `/api/agent/queue/*` | Add, list, remove, or clear queued prompts |

These routes require normal AboardAI application authentication.

## Renderer behavior

The renderer fetches session lists through the shared API client and caches server data with TanStack Query. Agent messages and activity are streamed from the backend; the server remains the source of truth for persisted histories and metadata.

A Vite hot reload can reconnect to the running backend. A backend restart does not preserve an in-memory provider process; the server persists session history and feature interruption state so the UI can recover honestly after restart.

## Operational guidance

- Use separate sessions for unrelated tasks or different working directories.
- Archive completed conversations instead of deleting them when future context may matter.
- Confirm the selected provider/model is available before starting a long run.
- Protect `DATA_DIR`: session histories and application-managed credentials may contain sensitive information.
- Do not edit session files while the server is writing them.

## Troubleshooting

If a session is missing, confirm the application is using the expected `DATA_DIR` and request archived sessions. If history does not load, inspect the matching file under `agent-sessions/` and the server logs for parse or permissions errors. If streamed output stops while the backend is healthy, reconnect the UI and refetch history; do not assume that a missing WebSocket event means the stored operation was lost.
