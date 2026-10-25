# SSH MCP Server

[English](README_EN.md)

本项目提供一个本地运行的 MCP (Model Context Protocol) 服务，通过 SSH 安全地远程操控服务器，支持命令执行和文件传输（SFTP）。

## 功能特性

- **安全连接**：支持密码和私钥两种认证方式
- **命令执行**：在远程服务器上执行命令并获取输出
- **文件传输**：支持 SFTP 上传、下载、读写文件
- **目录操作**：列出目录、创建目录、删除文件/目录、重命名
- **自动连接**：支持通过环境变量预配置服务器，启动时自动连接
- **会话管理**：支持多会话并发，可列出和断开会话
- **超时控制**：连接和命令执行都支持超时设置
- **连接保活**：内置 SSH Keepalive 机制，防止空闲连接被防火墙/NAT 设备断开
- **自动重连**：连接意外断开时透明重连，SFTP 会话自动恢复，业务操作无感知
- **重试机制**：操作失败时自动按指数退避策略重试，含随机抖动避免雪崩
- **路径兼容**：自动展开 `~` 路径（如 `~/.ssh/id_rsa`），兼容常见配置写法

## 安装

```bash
# 克隆项目
git clone https://github.com/your-name/ssh.git
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

使用私钥认证（更安全）：

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

#### 方式二：手动连接

不配置环境变量，使用时通过 `ssh_connect` 工具手动连接：

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

### 在 Claude Desktop 中配置

编辑 Claude Desktop 配置文件：
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

### 在 Claude Code (VS Code 扩展) 中配置

在项目根目录创建 `.mcp.json` 文件：

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

或者在 VS Code 设置中配置全局 MCP 服务器。

### 在 Codex CLI 中配置

编辑 Codex 配置文件 `~/.codex/config.json`：

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

### 使用 npx 运行（无需克隆）

如果项目已发布到 npm，可以直接使用 npx：

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

### 路径说明

配置中的 `/path/to/ssh/dist/index.js` 需要替换为实际路径：

- **Windows**: `C:/Users/yourname/projects/ssh/dist/index.js`
- **macOS/Linux**: `/home/yourname/projects/ssh/dist/index.js`

> 提示：Windows 路径可以使用正斜杠 `/` 或双反斜杠 `\\`

## 环境变量

| 变量名 | 必填 | 说明 |
|--------|------|------|
| SSH_HOST | 是 | 服务器地址 |
| SSH_PORT | 否 | SSH 端口，默认 22 |
| SSH_USERNAME | 是 | 用户名 |
| SSH_PASSWORD | 否* | 密码认证 |
| SSH_PRIVATE_KEY | 否* | 私钥内容（Base64 编码） |
| SSH_PRIVATE_KEY_PATH | 否* | 私钥文件路径（支持 `~` 展开） |
| SSH_PASSPHRASE | 否 | 私钥密码 |
| SSH_TIMEOUT | 否 | 命令执行超时（毫秒），默认 30000 |
| SSH_CONNECT_TIMEOUT | 否 | 连接超时（毫秒），默认 10000 |
| SSH_KEEPALIVE_INTERVAL | 否 | Keepalive 探测间隔（毫秒），默认 10000。设为 0 可禁用 |
| SSH_KEEPALIVE_COUNT | 否 | Keepalive 最大无响应次数，超过后判定连接死亡，默认 3 |
| SSH_MAX_RECONNECT_ATTEMPTS | 否 | 自动重连最大尝试次数，默认 3 |
| SSH_RECONNECT_BASE_DELAY | 否 | 重连基础延迟（毫秒），默认 1000 |
| SSH_RECONNECT_MAX_DELAY | 否 | 重连最大延迟上限（毫秒），默认 10000 |
| SSH_STRICT_HOST_KEY_CHECKING | 否 | `yes`、`accept-new`、`no`。默认 `accept-new`：第一次见到主机时写入 known_hosts，密钥变化则拒绝连接 |
| SSH_KNOWN_HOSTS | 否 | known_hosts 文件路径，默认 `~/.ssh/known_hosts` |
| SSH_HOST_FINGERPRINT | 否 | 固定的 `SHA256:...` 主机指纹，不匹配则拒绝连接 |
| SSH_SFTP_TIMEOUT | 否 | SFTP 无进展超时（毫秒），默认 30000 |

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
- `private_key` (string, 可选): 私钥内容
- `private_key_path` (string, 可选): 私钥文件路径
- `passphrase` (string, 可选): 私钥密码
- `keepalive_interval` (number, 可选): Keepalive 探测间隔（毫秒），默认 10000
- `keepalive_count` (number, 可选): 最大无响应次数，默认 3
- `strict_host_key_checking` (string, 可选): `yes`、`accept-new` 或 `no`
- `known_hosts_path` (string, 可选): known_hosts 文件路径
- `host_fingerprint` (string, 可选): 要求匹配的 `SHA256:` 主机指纹

成功时返回 `session_id`、`host_fingerprint` 和 `host_key_type`。

#### ssh_exec
执行远程命令。预配置服务器时无需提供 `session_id`。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `command` (string, 必填): 要执行的命令
- `timeout` (number, 可选): 本次命令的超时时间（毫秒），范围 1000–300000。超时后关闭执行通道，并且不会自动再执行这条命令。关闭通道不能保证已经脱离会话的远端进程一定停止。
- `background` (boolean, 可选): 为 true 时立即返回 `job_id`，命令继续在服务器上运行。用 `ssh_exec_poll` 查看输出，用 `ssh_exec_cancel` 关闭执行通道。后台任务只存在于当前 MCP 进程里。

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
按字节分段读取远程文件。空文件返回空内容。`utf8` 不会把一个字切成两半，继续读时使用返回的 `next_offset`。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `path` (string, 必填): 远程文件路径
- `offset` (number, 可选): 起始字节，默认 0
- `limit` (number, 可选): 最多读取的字节数，默认 25000
- `encoding` (string, 可选): `utf8` 或 `base64`，默认 `utf8`
- `timeout` (number, 可选): 无进展超时（毫秒）

```
示例：sftp_read(path="/etc/nginx/nginx.conf", offset=0, limit=4000)
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
| 文件读取 | 每段最多 25000 字节 | `sftp_read` 用 `offset` / `next_offset` 继续读取 |
| 命令长度 | 1000 字符 | `ssh_exec` 命令字符串最大长度 |
| 命令输出 | 25000 字符 | 超过会被截断 |

## 连接可靠性

SSH MCP Server 内置了一套完整的连接保活与自动恢复机制，确保长时间使用的稳定性：

### Keepalive 保活

- 默认每 **10 秒** 向服务器发送一次 keepalive 探测包
- 连续 **3 次** 无响应后判定连接死亡
- 有效防止防火墙/NAT 设备因空闲超时而断开连接
- 可通过 `SSH_KEEPALIVE_INTERVAL` 和 `SSH_KEEPALIVE_COUNT` 自定义

### 自动重连

- 当检测到连接断开时，同一个会话只会发起一次重连，避免并发操作互相拆掉新连接
- 重连成功后，还没开始的操作会继续
- SFTP 会话在重连后重新打开

### 指数退避重试

- 操作失败时自动重试，最多 **3 次**（含首次尝试）
- 每次重试的等待时间按指数增长：`baseDelay × 2^attempt`
- 加入 ±25% 随机抖动，避免多客户端同时重试造成雪崩
- 只重试尚未开始的连接错误
- 认证失败、主机密钥拒绝、命令超时不会重试
- 命令通道一旦打开，或删除、重命名已经发到远端，失败后不会再执行一次
- 可通过 `SSH_MAX_RECONNECT_ATTEMPTS`、`SSH_RECONNECT_BASE_DELAY`、`SSH_RECONNECT_MAX_DELAY` 自定义

## 安全注意事项

**重要安全提示：**

1. **凭据保护**：密码和私钥仅在内存中保存，不会持久化到磁盘
2. **主机密钥**：默认 `accept-new`。新主机的公钥写入 known_hosts；同一主机的密钥发生变化时拒绝连接。需要固定目标时设置 `SSH_HOST_FINGERPRINT`。`no` 会跳过 known_hosts 比对，只在你明确接受风险时使用
3. **文件替换**：上传、下载和远程写入先写临时文件，核对字节数后再替换目标。下载目录或传输失败不会清空原来的本地文件
4. **日志安全**：日志中不会打印密码和私钥内容
5. **会话清理**：服务关闭时会自动清理所有会话
6. **命令限制**：命令长度限制为 1000 字符，避免滥用
7. **输出限制**：输出超过 25000 字符会被截断
8. **环境变量**：建议使用私钥认证而非密码，更安全
9. **配置文件安全**：不要将包含密码的配置文件提交到版本控制

## 技术栈

- **运行时**：Node.js 18+
- **语言**：TypeScript 5
- **MCP SDK**：@modelcontextprotocol/sdk
- **SSH 库**：ssh2
- **参数校验**：Zod
- **测试框架**：Vitest

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件
