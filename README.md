# SSH MCP Server

本项目提供一个本地运行的 MCP (Model Context Protocol) 服务，通过 SSH 安全地远程操控服务器，支持命令执行和文件传输（SFTP）。

## 功能特性

- **安全连接**：支持密码和私钥两种认证方式
- **命令执行**：在远程服务器上执行命令并获取输出
- **文件传输**：支持 SFTP 上传、下载、读写文件
- **目录操作**：列出目录、创建目录、删除文件/目录、重命名
- **自动连接**：支持通过环境变量预配置服务器，启动时自动连接
- **会话管理**：支持多会话并发，可列出和断开会话
- **超时控制**：连接和命令执行都支持超时设置

## 安装

```bash
# 克隆项目
git clone https://github.com/lilyjem/ssh.git
cd ssh

# 安装依赖
npm install

# 构建项目
npm run build
```

## 配置方式

### 在 Cursor 中配置

在 Cursor 设置中找到 MCP 配置（`~/.cursor/mcp.json` 或通过设置界面），添加以下配置：

#### 方式一：预配置服务器（推荐）

通过环境变量预配置服务器信息，启动时自动连接：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-test-mcp/dist/index.js"],
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

使用私钥认证（更安全）：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-test-mcp/dist/index.js"],
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

#### 方式二：手动连接

不配置环境变量，使用时通过 `ssh_connect` 工具手动连接：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-test-mcp/dist/index.js"]
    }
  }
}
```

### 在 Claude Desktop 中配置

编辑 Claude Desktop 配置文件：
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-test-mcp/dist/index.js"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_USERNAME": "root",
        "SSH_PASSWORD": "your-password"
      }
    }
  }
}
```

### 在 Claude Code (VS Code 扩展) 中配置

在项目根目录创建 `.mcp.json` 文件：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-test-mcp/dist/index.js"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_USERNAME": "root",
        "SSH_PRIVATE_KEY_PATH": "~/.ssh/id_rsa"
      }
    }
  }
}
```

或者在 VS Code 设置中配置全局 MCP 服务器。

### 在 Codex CLI 中配置

编辑 Codex 配置文件 `~/.codex/config.json`：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-test-mcp/dist/index.js"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_USERNAME": "root",
        "SSH_PASSWORD": "your-password"
      }
    }
  }
}
```

### 使用 npx 运行（无需克隆）

如果项目已发布到 npm，可以直接使用 npx：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["ssh-test-mcp"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_USERNAME": "root",
        "SSH_PASSWORD": "your-password"
      }
    }
  }
}
```

### 路径说明

配置中的 `/path/to/ssh-test-mcp/dist/index.js` 需要替换为实际路径：

- **Windows**: `C:/Users/yourname/projects/ssh-test-mcp/dist/index.js`
- **macOS/Linux**: `/home/yourname/projects/ssh-test-mcp/dist/index.js`

> 提示：Windows 路径可以使用正斜杠 `/` 或双反斜杠 `\\`

## 环境变量

| 变量名 | 必填 | 说明 |
|--------|------|------|
| SSH_HOST | 是 | 服务器地址 |
| SSH_PORT | 否 | SSH 端口，默认 22 |
| SSH_USERNAME | 是 | 用户名 |
| SSH_PASSWORD | 否* | 密码认证 |
| SSH_PRIVATE_KEY | 否* | 私钥内容（Base64 编码） |
| SSH_PRIVATE_KEY_PATH | 否* | 私钥文件路径 |
| SSH_PASSPHRASE | 否 | 私钥密码 |
| SSH_TIMEOUT | 否 | 命令执行超时（毫秒），默认 30000 |
| SSH_CONNECT_TIMEOUT | 否 | 连接超时（毫秒），默认 10000 |

> *注：密码、私钥内容、私钥路径三者至少提供一个

## 工具列表

### SSH 连接管理

#### ssh_connect
创建新的 SSH 连接（预配置服务器时可选）。

**参数：**
- `host` (string, 必填): 服务器地址
- `port` (number, 可选): SSH 端口，默认 22
- `username` (string, 必填): 用户名
- `password` (string, 可选): 密码
- `privateKey` (string, 可选): 私钥内容
- `passphrase` (string, 可选): 私钥密码

#### ssh_exec
执行远程命令。预配置服务器时无需提供 `session_id`。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `command` (string, 必填): 要执行的命令
- `timeout` (number, 可选): 超时时间（毫秒）

```
示例：ssh_exec(command="ls -la /var/log")
```

#### ssh_list_sessions
列出所有活跃的 SSH 会话。

#### ssh_disconnect
断开 SSH 连接。

**参数：**
- `session_id` (string, 必填): 要断开的会话 ID

### SFTP 文件操作

#### sftp_list
列出远程目录内容。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `path` (string, 可选): 目录路径，默认 `/`

```
示例：sftp_list(path="/home/user")
```

#### sftp_upload
上传本地文件到远程服务器。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `local_path` (string, 必填): 本地文件路径
- `remote_path` (string, 必填): 远程目标路径

```
示例：sftp_upload(local_path="/local/file.txt", remote_path="/home/user/file.txt")
```

#### sftp_download
从远程服务器下载文件到本地。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `remote_path` (string, 必填): 远程文件路径
- `local_path` (string, 必填): 本地目标路径

```
示例：sftp_download(remote_path="/var/log/syslog", local_path="/local/logs/syslog.txt")
```

#### sftp_read
读取远程文件内容（适用于文本文件）。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `path` (string, 必填): 远程文件路径
- `encoding` (string, 可选): 编码，默认 `utf-8`

```
示例：sftp_read(path="/etc/nginx/nginx.conf")
```

#### sftp_write
写入内容到远程文件。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `path` (string, 必填): 远程文件路径
- `content` (string, 必填): 要写入的内容

```
示例：sftp_write(path="/home/user/test.txt", content="Hello World")
```

#### sftp_delete
删除远程文件或空目录。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `path` (string, 必填): 要删除的路径

```
示例：sftp_delete(path="/home/user/old-file.txt")
```

#### sftp_mkdir
创建远程目录。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `path` (string, 必填): 目录路径

```
示例：sftp_mkdir(path="/home/user/new-folder")
```

#### sftp_rename
重命名或移动远程文件/目录。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `old_path` (string, 必填): 原路径
- `new_path` (string, 必填): 新路径

```
示例：sftp_rename(old_path="/home/user/old.txt", new_path="/home/user/new.txt")
```

## 使用示例

### 预配置服务器模式

配置好环境变量后，服务启动时会自动连接，可以直接使用：

```
用户：查看服务器上的 /var/log 目录
AI：调用 sftp_list(path="/var/log")

用户：查看 nginx 配置
AI：调用 sftp_read(path="/etc/nginx/nginx.conf")

用户：重启 nginx 服务
AI：调用 ssh_exec(command="systemctl restart nginx")

用户：上传本地的配置文件到服务器
AI：调用 sftp_upload(local_path="/local/config/app.conf", remote_path="/etc/app/app.conf")
```

### 手动连接模式

```
用户：连接到我的服务器 192.168.1.100
AI：调用 ssh_connect(host="192.168.1.100", username="root", password="xxx")
    返回 session_id

用户：执行 ls 命令
AI：调用 ssh_exec(session_id="xxx", command="ls -la")

用户：断开连接
AI：调用 ssh_disconnect(session_id="xxx")
```

## 开发

```bash
# 运行测试
npm test

# 监听模式运行测试
npm run test:watch

# 开发模式（热重载）
npm run dev

# 构建
npm run build
```

## 限制说明

| 项目 | 限制 | 说明 |
|------|------|------|
| 文件上传 | **无大小限制** | 使用流式传输，支持任意大小文件 |
| 文件下载 | **无大小限制** | 使用流式传输，支持任意大小文件 |
| 文件读取 | 25000 字符 | `sftp_read` 读取文本文件内容时会截断 |
| 命令长度 | 1000 字符 | `ssh_exec` 命令字符串最大长度 |
| 命令输出 | 25000 字符 | 超过会被截断 |

## 安全注意事项

**重要安全提示：**

1. **凭据保护**：密码和私钥仅在内存中保存，不会持久化到磁盘
2. **日志安全**：日志中不会打印密码和私钥内容
3. **会话清理**：服务关闭时会自动清理所有会话
4. **命令限制**：命令长度限制为 1000 字符，避免滥用
5. **输出限制**：输出超过 25000 字符会被截断
6. **环境变量**：建议使用私钥认证而非密码，更安全
7. **配置文件安全**：不要将包含密码的配置文件提交到版本控制

## 技术栈

- **运行时**：Node.js 18+
- **语言**：TypeScript 5
- **MCP SDK**：@modelcontextprotocol/sdk
- **SSH 库**：ssh2
- **参数校验**：Zod
- **测试框架**：Vitest

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件
