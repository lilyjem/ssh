# SSH MCP Server

[中文文档](README.md)

A locally running MCP (Model Context Protocol) server that securely controls remote servers via SSH, supporting command execution and file transfer (SFTP).

## Features

- **Secure Connection**: Supports both password and private key authentication
- **Command Execution**: Execute commands on remote servers and get output
- **File Transfer**: SFTP upload, download, read and write files
- **Directory Operations**: List, create, delete directories, rename files
- **Auto Connect**: Pre-configure server via environment variables for automatic connection on startup
- **Session Management**: Support multiple concurrent sessions, list and disconnect sessions
- **Timeout Control**: Configurable timeouts for connection and command execution
- **Connection Keepalive**: Built-in SSH keepalive mechanism to prevent idle connections from being dropped by firewalls/NAT
- **Auto Reconnect**: Transparent reconnection on unexpected disconnects with automatic SFTP session recovery
- **Retry Mechanism**: Automatic exponential backoff retry on operation failures with random jitter to avoid thundering herd
- **Path Compatibility**: Auto-expands `~` paths (e.g. `~/.ssh/id_rsa`) for common configuration patterns

## Installation

Requires Node.js 18+ with npm/npx. Git is only needed for source installation.

### Option 1: Use the npm Package (Recommended)

Available on npm as [**@lilyjem/ssh-mcp-server**](https://www.npmjs.com/package/@lilyjem/ssh-mcp-server), currently version `0.2.0`. No clone or manual build is required. Add this to your Cursor or Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "@lilyjem/ssh-mcp-server@0.2.0"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_PORT": "22",
        "SSH_USERNAME": "your-username",
        "SSH_PASSWORD": "your-password"
      }
    }
  }
}
```

The first launch downloads the package and requires internet access. Restart the client after saving. The example pins the version to avoid automatic upgrades; change it explicitly when upgrading. You may omit `env` and let the agent call `ssh_connect` instead.

### Option 2: Install from Source

```bash
# Clone the project
git clone https://github.com/lilyjem/ssh.git
cd ssh

# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

The examples below use the locally built source entry point. For npm usage, replace `command` with `npx` and `args` with `["-y", "@lilyjem/ssh-mcp-server@0.2.0"]`, keeping the same environment variables.

Default examples use username/password authentication. Replace the placeholders with your server credentials, and never commit configurations containing real passwords. Private key authentication remains available as an alternative below.

### Cursor IDE

Find MCP configuration in Cursor settings (`~/.cursor/mcp.json` or via settings UI):

#### Option 1: Pre-configured Server (Recommended)

Pre-configure server info via environment variables for automatic connection:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh/dist/index.js"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_PORT": "22",
        "SSH_USERNAME": "root",
        "SSH_PASSWORD": "your-password"
      }
    }
  }
}
```

Using private key authentication (more secure):

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh/dist/index.js"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_PORT": "22",
        "SSH_USERNAME": "root",
        "SSH_PRIVATE_KEY_PATH": "~/.ssh/id_rsa",
        "SSH_PASSPHRASE": "optional-passphrase"
      }
    }
  }
}
```

#### Option 2: Manual Connection

Without environment variables, use `ssh_connect` tool to connect manually:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh/dist/index.js"]
    }
  }
}
```

### Claude Desktop

Edit Claude Desktop config file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh/dist/index.js"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_USERNAME": "root",
        "SSH_PASSWORD": "your-password"
      }
    }
  }
}
```

### Claude Code (VS Code Extension)

Create `.mcp.json` file in project root:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh/dist/index.js"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_USERNAME": "root",
        "SSH_PASSWORD": "your-password"
      }
    }
  }
}
```

Or configure global MCP servers in VS Code settings.

### Codex CLI

Edit Codex config file `~/.codex/config.json`:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh/dist/index.js"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_USERNAME": "root",
        "SSH_PASSWORD": "your-password"
      }
    }
  }
}
```

### Release Installation

The official npm package is `@lilyjem/ssh-mcp-server`. Do not use `npx ssh` or the unscoped `ssh-mcp-server` package, which is not this project. For source installation, check out `v0.2.0`, run `npm ci` and `npm run build`, then configure the local `dist/index.js` path. The path notes below apply only to source installations.

### Path Notes

Replace `/path/to/ssh/dist/index.js` with actual path:

- **Windows**: `C:/Users/yourname/projects/ssh/dist/index.js`
- **macOS/Linux**: `/home/yourname/projects/ssh/dist/index.js`

> Tip: Windows paths can use forward slashes `/` or double backslashes `\\`

The client targets Windows, macOS, and Linux. The remote host must provide SSH/SFTP and interprets commands using its own system; commands are not translated between operating systems. Windows access control depends on system ACLs, not POSIX `0600` modes. The current version has been validated on macOS; Windows validation has been completed by the user. Linux remains unverified on a native machine because none is available.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| SSH_HOST | Yes | Server address |
| SSH_PORT | No | SSH port, default 22 |
| SSH_USERNAME | Yes | Username |
| SSH_PASSWORD | No* | Password authentication |
| SSH_PRIVATE_KEY | No* | Private key content (raw PEM or Base64-encoded PEM) |
| SSH_PRIVATE_KEY_PATH | No* | Private key file path (supports `~` expansion) |
| SSH_PASSPHRASE | No | Private key passphrase |
| SSH_TIMEOUT | No | Command timeout (ms), default 30000 |
| SSH_CONNECT_TIMEOUT | No | Connection timeout (ms), default 10000 |
| SSH_KEEPALIVE_INTERVAL | No | Keepalive probe interval (ms), default 10000. Set to 0 to disable |
| SSH_KEEPALIVE_COUNT | No | Max unresponsive keepalive probes before declaring connection dead, default 3 |
| SSH_MAX_RECONNECT_ATTEMPTS | No | Total attempts including the first, default 3; positive integer, 1 disables retries, 0 is invalid |
| SSH_RECONNECT_BASE_DELAY | No | Reconnect base delay (ms), default 1000 |
| SSH_RECONNECT_MAX_DELAY | No | Reconnect max delay cap (ms), default 10000 |
| SSH_STRICT_HOST_KEY_CHECKING | No | `yes`, `accept-new`, or `no`. Default `accept-new`: store a new host key, reject a changed key |
| SSH_KNOWN_HOSTS | No | known_hosts path, default `~/.ssh/known_hosts` |
| SSH_HOST_FINGERPRINT | No | Required `SHA256:...` host fingerprint |
| SSH_SFTP_TIMEOUT | No | SFTP inactivity timeout in ms, default 30000 |

> *Note: At least one of password, private key content, or private key path is required

There are **two authentication methods and three input forms**: password, or a private key supplied as content or a file path. Encrypted keys accept a passphrase; this is not a separate authentication method. SSH Agent, keyboard-interactive authentication, and MFA are not supported.

Numeric environment values must be complete integers, without units or fractions. Command/SFTP timeouts: 1000–300000ms; connect timeout: 1000–60000ms; keepalive interval: 0–3600000ms; keepalive count: 1–100; attempts: 1–1000; backoff delays: 1–600000ms.

SFTP deadlines cover subsystem initialization, reads/writes, and final rename. Received read data and server-acknowledged write blocks refresh inactivity timers. These are phase inactivity limits, not total transfer duration limits; write progress is observed at application-write-block granularity.

Concurrent calls share SFTP initialization but have independent waiting deadlines and cancellation. The underlying initialization is separately capped by `SSH_SFTP_TIMEOUT` (30000ms by default); an unfinished initialization is closed when its last waiter leaves.

## Tools

### SSH Connection Management

#### ssh_connect
Create a new SSH connection (optional when using pre-configured server).

**Parameters:**
- `host` (string, required): Server address
- `port` (number, optional): SSH port, default 22
- `username` (string, required): Username
- `password` (string, optional): Password
- `private_key` (string, optional): Private key content
- `private_key_path` (string, optional): Private key file path
- `passphrase` (string, optional): Private key passphrase
- `timeout` (number, optional): Default command timeout in milliseconds; defaults to `SSH_TIMEOUT`
- `connect_timeout` (number, optional): Connection timeout in milliseconds; defaults to `SSH_CONNECT_TIMEOUT`
- `keepalive_interval` (number, optional): Keepalive probe interval (ms), default 10000
- `keepalive_count` (number, optional): Max unresponsive probes, default 3
- `strict_host_key_checking` (string, optional): `yes`, `accept-new`, or `no`
- `known_hosts_path` (string, optional): known_hosts file
- `host_fingerprint` (string, optional): Required `SHA256:` host fingerprint

A successful result includes `session_id`, `host_fingerprint`, and `host_key_type`.

If a known host changes its key or algorithm, verify the new fingerprint through a trusted channel before updating known_hosts. Do not use `no` simply to bypass the warning.

Hashed host records are checked against both the supplied spelling and its lowercase token. Hashes cannot reveal other mixed-case spellings used by external tools; use lowercase hostnames consistently when generating and using hashed records, and pin fingerprints for higher-assurance connections.

#### ssh_exec
Execute remote command. No `session_id` needed when using pre-configured server.

**Parameters:**
- `session_id` (string, optional): Session ID
- `command` (string, required): Command to execute
- `timeout` (number, optional): Timeout for this call in milliseconds (1000–300000). On timeout the execution channel is closed and the command is not run again. Closing the channel does not prove that a detached remote process has stopped.
- `background` (boolean, optional): Return a `job_id` immediately. Use `ssh_exec_poll` and `ssh_exec_cancel`. Jobs live only in the current MCP process.

If a started command loses its connection before reporting an exit status, the call fails with an unknown execution outcome and is not replayed. Check the remote state before retrying.

```
Example: ssh_exec(command="ls -la /var/log")
```

#### ssh_exec_poll
Read the current output and status of a background job.

**Parameters:**
- `job_id` (string, required): Job ID returned by `ssh_exec`
- `stdout_offset` (number, optional): Starting offset for stdout

Returns `status`, `exit_code`, `next_stdout_offset`, and incremental stdout / stderr.

Up to 32 background jobs are retained. Terminal jobs expire lazily after 15 minutes and may be evicted earlier for capacity; when all 32 are running, new jobs are rejected. Disconnecting cancels and removes that session's jobs. Poll offsets use JavaScript UTF-16 string indexes; reuse `next_stdout_offset` unchanged.

#### ssh_exec_cancel
Close a background job's execution channel. Closing the channel does not guarantee that a detached remote process has stopped.

**Parameters:**
- `job_id` (string, required): Job ID returned by `ssh_exec`

#### ssh_list_sessions
List all active SSH sessions.

#### ssh_disconnect
Disconnect SSH session.

**Parameters:**
- `session_id` (string, optional): Session ID to disconnect; omit to disconnect the pre-configured default session

### SFTP File Operations

#### sftp_list
List remote directory contents.

**Parameters:**
- `session_id` (string, optional): Session ID
- `path` (string, optional): Directory path, default `/`

```
Example: sftp_list(path="/home/user")
```

#### sftp_upload
Upload local file to remote server.

**Parameters:**
- `session_id` (string, optional): Session ID
- `local_path` (string, required): Local file path
- `remote_path` (string, required): Remote destination path

```
Example: sftp_upload(local_path="/local/file.txt", remote_path="/home/user/file.txt")
```

#### sftp_download
Download file from remote server to local.

**Parameters:**
- `session_id` (string, optional): Session ID
- `remote_path` (string, required): Remote file path
- `local_path` (string, required): Local destination path

```
Example: sftp_download(remote_path="/var/log/syslog", local_path="/local/logs/syslog.txt")
```

#### sftp_read
Read a byte range of a remote file. An empty file returns empty content. `utf8` does not split a character; continue from `next_offset`.

If `limit` cannot hold the next complete UTF-8 character, the call fails explicitly instead of returning a non-advancing empty page. Increase `limit` (usually to at least 4), or use `base64` for exact bytes.

**Parameters:**
- `session_id` (string, optional): Session ID
- `path` (string, required): Remote file path
- `offset` (number, optional): Starting byte, default 0
- `limit` (number, optional): Maximum bytes, default 25000
- `encoding` (string, optional): `utf8` or `base64`, default `utf8`
- `timeout` (number, optional): Inactivity timeout in milliseconds

```
Example: sftp_read(path="/etc/nginx/nginx.conf", offset=0, limit=4000)
```

#### sftp_write
Write content to remote file.

**Parameters:**
- `session_id` (string, optional): Session ID
- `path` (string, required): Remote file path
- `content` (string, required): Content to write

```
Example: sftp_write(path="/home/user/test.txt", content="Hello World")
```

#### sftp_delete
Delete remote file or empty directory.

**Parameters:**
- `session_id` (string, optional): Session ID
- `path` (string, required): Path to delete

```
Example: sftp_delete(path="/home/user/old-file.txt")
```

#### sftp_mkdir
Create remote directory.

**Parameters:**
- `session_id` (string, optional): Session ID
- `path` (string, required): Directory path

```
Example: sftp_mkdir(path="/home/user/new-folder")
```

#### sftp_rename
Rename or move remote file/directory.

**Parameters:**
- `session_id` (string, optional): Session ID
- `old_path` (string, required): Original path
- `new_path` (string, required): New path

```
Example: sftp_rename(old_path="/home/user/old.txt", new_path="/home/user/new.txt")
```

## Usage Examples

### Pre-configured Server Mode

After configuring environment variables, the service auto-connects on startup:

```
User: List /var/log directory on server
AI: Calls sftp_list(path="/var/log")

User: View nginx config
AI: Calls sftp_read(path="/etc/nginx/nginx.conf")

User: Restart nginx service
AI: Calls ssh_exec(command="systemctl restart nginx")

User: Upload local config file to server
AI: Calls sftp_upload(local_path="/local/config/app.conf", remote_path="/etc/app/app.conf")
```

### Manual Connection Mode

```
User: Connect to my server 192.168.1.100
AI: Calls ssh_connect(host="192.168.1.100", username="root", password="xxx")
    Returns session_id

User: Execute ls command
AI: Calls ssh_exec(session_id="xxx", command="ls -la")

User: Disconnect
AI: Calls ssh_disconnect(session_id="xxx")
```

## Development

```bash
# Run tests
npm test

# Watch mode tests
npm run test:watch

# Development mode (hot reload)
npm run dev

# Build
npm run build
```

## Limits

| Item | Limit | Description |
|------|-------|-------------|
| File Upload | **No limit** | Uses streaming, supports any file size |
| File Download | **No limit** | Uses streaming, supports any file size |
| File Read | 25000 bytes per call | Continue with `offset` / `next_offset` |
| Command Length | 1000 chars | `ssh_exec` max command string length |
| Command Output | 25000 chars | Output exceeding limit is truncated |

## Connection Reliability

SSH MCP Server includes a comprehensive connection keepalive and auto-recovery mechanism for long-running stability:

### Keepalive

- Sends a keepalive probe to the server every **10 seconds** by default
- Declares connection dead after **3** consecutive unresponsive probes
- Effectively prevents firewalls/NAT devices from dropping idle connections
- Customizable via `SSH_KEEPALIVE_INTERVAL` and `SSH_KEEPALIVE_COUNT`

### Auto Reconnect

- A disconnected session is reconnected once, even if several operations notice the drop together
- Operations that have not started continue after reconnect
- The SFTP session is opened again after reconnect

### Exponential Backoff Retry

- Automatically retries failed operations, up to **3 attempts** (including the initial try)
- Wait time between retries grows exponentially: `baseDelay × 2^attempt`
- Adds ±25% random jitter to prevent thundering herd from concurrent clients
- Retries only connection errors for work that has not started
- Authentication failures, host-key rejections, and command timeouts are not retried
- A command is not run again after its channel opens. Delete and rename are not repeated after they are sent
- Customizable via `SSH_MAX_RECONNECT_ATTEMPTS`, `SSH_RECONNECT_BASE_DELAY`, `SSH_RECONNECT_MAX_DELAY`

## Security Notes

**Important Security Tips:**

1. **Credential Protection**: Passwords and private keys are only stored in memory, never persisted to disk
2. **Host keys**: Default `accept-new` uses trust on first use (TOFU). A known host presenting a nonmatching key is rejected, including an algorithm change. DNS matching is ASCII case-insensitive and honors negated patterns. This is not a complete OpenSSH configuration or certificate verifier; `@cert-authority` is unsupported. `SSH_HOST_FINGERPRINT` pins a key; `yes` still requires a matching known_hosts entry. `no` skips known_hosts, including revocations, but still checks a pinned fingerprint
3. **File replacement**: Upload, download, and remote write use a temporary file and verify its byte count before replacement. If safe remote overwrite is unavailable, the operation fails without first deleting the original. Remote temporary files may require manual cleanup after connection loss
4. **Log Security**: Passwords and private keys are never printed in logs
5. **Session Cleanup**: All sessions are automatically cleaned up when service shuts down
6. **Command Limit**: Command length limited to 1000 characters to prevent abuse
7. **Output Limit**: Output exceeding 25000 characters is truncated
8. **Environment Variables**: Private key authentication is recommended over password for better security
9. **Config File Security**: Never commit config files containing passwords to version control

## Tech Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript 5
- **MCP SDK**: @modelcontextprotocol/sdk
- **SSH Library**: ssh2
- **Validation**: Zod
- **Testing**: Vitest

## License

MIT License - See [LICENSE](LICENSE) file
