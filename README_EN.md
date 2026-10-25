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

```bash
# Clone the project
git clone https://github.com/your-name/ssh.git
cd ssh

# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

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
        "SSH_PRIVATE_KEY_PATH": "~/.ssh/id_rsa"
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

### Using npx (No Clone Required)

If published to npm, use npx directly:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["ssh"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_USERNAME": "root",
        "SSH_PASSWORD": "your-password"
      }
    }
  }
}
```

### Path Notes

Replace `/path/to/ssh/dist/index.js` with actual path:

- **Windows**: `C:/Users/yourname/projects/ssh/dist/index.js`
- **macOS/Linux**: `/home/yourname/projects/ssh/dist/index.js`

> Tip: Windows paths can use forward slashes `/` or double backslashes `\\`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| SSH_HOST | Yes | Server address |
| SSH_PORT | No | SSH port, default 22 |
| SSH_USERNAME | Yes | Username |
| SSH_PASSWORD | No* | Password authentication |
| SSH_PRIVATE_KEY | No* | Private key content (Base64 encoded) |
| SSH_PRIVATE_KEY_PATH | No* | Private key file path (supports `~` expansion) |
| SSH_PASSPHRASE | No | Private key passphrase |
| SSH_TIMEOUT | No | Command timeout (ms), default 30000 |
| SSH_CONNECT_TIMEOUT | No | Connection timeout (ms), default 10000 |
| SSH_KEEPALIVE_INTERVAL | No | Keepalive probe interval (ms), default 10000. Set to 0 to disable |
| SSH_KEEPALIVE_COUNT | No | Max unresponsive keepalive probes before declaring connection dead, default 3 |
| SSH_MAX_RECONNECT_ATTEMPTS | No | Max auto-reconnect attempts, default 3 |
| SSH_RECONNECT_BASE_DELAY | No | Reconnect base delay (ms), default 1000 |
| SSH_RECONNECT_MAX_DELAY | No | Reconnect max delay cap (ms), default 10000 |
| SSH_STRICT_HOST_KEY_CHECKING | No | `yes`, `accept-new`, or `no`. Default `accept-new`: store a new host key, reject a changed key |
| SSH_KNOWN_HOSTS | No | known_hosts path, default `~/.ssh/known_hosts` |
| SSH_HOST_FINGERPRINT | No | Required `SHA256:...` host fingerprint |
| SSH_SFTP_TIMEOUT | No | SFTP inactivity timeout in ms, default 30000 |

> *Note: At least one of password, private key content, or private key path is required

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
- `keepalive_interval` (number, optional): Keepalive probe interval (ms), default 10000
- `keepalive_count` (number, optional): Max unresponsive probes, default 3
- `strict_host_key_checking` (string, optional): `yes`, `accept-new`, or `no`
- `known_hosts_path` (string, optional): known_hosts file
- `host_fingerprint` (string, optional): Required `SHA256:` host fingerprint

A successful result includes `session_id`, `host_fingerprint`, and `host_key_type`.

#### ssh_exec
Execute remote command. No `session_id` needed when using pre-configured server.

**Parameters:**
- `session_id` (string, optional): Session ID
- `command` (string, required): Command to execute
- `timeout` (number, optional): Timeout for this call in milliseconds (1000–300000). On timeout the execution channel is closed and the command is not run again. Closing the channel does not prove that a detached remote process has stopped.
- `background` (boolean, optional): Return a `job_id` immediately. Use `ssh_exec_poll` and `ssh_exec_cancel`. Jobs live only in the current MCP process.

```
Example: ssh_exec(command="ls -la /var/log")
```

#### ssh_list_sessions
List all active SSH sessions.

#### ssh_disconnect
Disconnect SSH session.

**Parameters:**
- `session_id` (string, required): Session ID to disconnect

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
2. **Host keys**: Default `accept-new` stores an unseen host key in known_hosts and refuses the connection if that key later changes. Set `SSH_HOST_FINGERPRINT` to pin a key. `no` skips the known_hosts check
3. **File replacement**: Upload, download, and remote write use a temporary file and replace the target only after the byte count matches. A failed download does not truncate the existing local file
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
