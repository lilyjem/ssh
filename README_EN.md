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

## Installation

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
| SSH_PRIVATE_KEY_PATH | No* | Private key file path |
| SSH_PASSPHRASE | No | Private key passphrase |
| SSH_TIMEOUT | No | Command timeout (ms), default 30000 |
| SSH_CONNECT_TIMEOUT | No | Connection timeout (ms), default 10000 |

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
- `privateKey` (string, optional): Private key content
- `passphrase` (string, optional): Private key passphrase

#### ssh_exec
Execute remote command. No `session_id` needed when using pre-configured server.

**Parameters:**
- `session_id` (string, optional): Session ID
- `command` (string, required): Command to execute
- `timeout` (number, optional): Timeout in milliseconds

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
Read remote file content (for text files).

**Parameters:**
- `session_id` (string, optional): Session ID
- `path` (string, required): Remote file path
- `encoding` (string, optional): Encoding, default `utf-8`

```
Example: sftp_read(path="/etc/nginx/nginx.conf")
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
| File Read | 25000 chars | `sftp_read` truncates text file content |
| Command Length | 1000 chars | `ssh_exec` max command string length |
| Command Output | 25000 chars | Output exceeding limit is truncated |

## Security Notes

**Important Security Tips:**

1. **Credential Protection**: Passwords and private keys are only stored in memory, never persisted to disk
2. **Log Security**: Passwords and private keys are never printed in logs
3. **Session Cleanup**: All sessions are automatically cleaned up when service shuts down
4. **Command Limit**: Command length limited to 1000 characters to prevent abuse
5. **Output Limit**: Output exceeding 25000 characters is truncated
6. **Environment Variables**: Private key authentication is recommended over password for better security
7. **Config File Security**: Never commit config files containing passwords to version control

## Tech Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript 5
- **MCP SDK**: @modelcontextprotocol/sdk
- **SSH Library**: ssh2
- **Validation**: Zod
- **Testing**: Vitest

## License

MIT License - See [LICENSE](LICENSE) file
