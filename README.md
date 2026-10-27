# SSH MCP Server

[English](README_EN.md)

本项目提供一个本地运行的 MCP (Model Context Protocol) 服务，通过 SSH 安全地远程操控服务器，支持命令执行和文件传输（SFTP）。

## 背景：让 Agent 把项目从本地一路送到服务器

用 Agent 在本地把项目写出来、跑起来，已经不是难事。真正卡住新手的是最后一步：把项目部署到服务器。不会用 SSH、不熟悉 Linux 命令、怕敲错一条命令把线上环境弄坏，很多人到这里就停住了。

这个项目的目标是让“部署到服务器”也变成 Agent 可以全自动完成的一步，同时保证安全。

具体做法是提供一个只在你本机运行的 MCP 服务，把 SSH 命令执行和 SFTP 文件操作暴露成一组受控工具：

- **Agent 通过工具操作服务器**：你只需要用自然语言描述目标，由 Agent 完成连接、上传、执行和排错，不用自己背命令
- **凭据不离开本机**：MCP 进程运行在你的电脑上，服务器端不需要安装任何东西，密码和私钥不会发给第三方服务
- **安全约束放在工具层**：主机密钥校验、失败不重放非幂等操作、原子文件替换、命令和输出长度限制，避免 Agent 的一次误操作直接变成线上事故
- **连接可靠**：keepalive 保活、断线自动重连、指数退避重试，让部署过程不会因为网络抖动中断

配置完成后，你可以直接对 Agent 说“把这个项目部署到我的服务器”，它会自己完成后续操作。

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
- **路径兼容**：自动展开 `~` 路径（支持 `~/` 和 Windows 的 `~\` 写法，如 `~/.ssh/id_rsa`）

## 安装

前置条件：Node.js 18+、Git。

### 方式一：让 Agent 帮你安装（推荐）

把下面这段话直接发给 Cursor、Claude Code、Claude Desktop 或 Codex 里的 Agent：

> 帮我安装并配置这个 SSH MCP 服务器：https://github.com/lilyjem/ssh
>
> 把仓库克隆到 ~/ssh-mcp，执行 npm install 和 npm run build，
> 然后用克隆后 dist/index.js 的绝对路径，把它注册到当前客户端的 MCP 配置里。
> 装好后告诉我需要提供哪些服务器信息，并提醒我重启客户端。

Agent 会自己完成克隆、安装、构建和 MCP 注册。重启客户端后，MCP 服务就会加载。

### 方式二：手动安装

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

下面的示例都通过环境变量预配置服务器，MCP 启动时自动连接。不写 `env` 也能用，连接时改由 Agent 调用 `ssh_connect`。

支持 **2 类认证、3 种传入方式**：密码认证（`SSH_PASSWORD`），或私钥认证（`SSH_PRIVATE_KEY_PATH` 指定文件、`SSH_PRIVATE_KEY` 提供原始 PEM 或其 Base64 编码）。加密私钥可通过 `SSH_PASSPHRASE` 提供口令；口令不是第三类认证。暂不支持 SSH Agent、keyboard-interactive 或 MFA。

路径中的 `/path/to/ssh-mcp/dist/index.js` 换成克隆后的真实路径（见「路径说明」）。

### Claude Code

用命令行注册到用户级配置，对所有项目生效：

```bash
claude mcp add ssh -s user \
  -e SSH_HOST=your-server-ip \
  -e SSH_PORT=22 \
  -e SSH_USERNAME=your-username \
  -e SSH_PRIVATE_KEY_PATH=~/.ssh/id_rsa \
  -- node /path/to/ssh-mcp/dist/index.js
```

`-s` 还可以用 `local`（仅当前项目）或 `project`（写入项目根目录的 `.mcp.json`，随仓库共享）。也可以直接编辑项目的 `.mcp.json`：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-mcp/dist/index.js"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_PORT": "22",
        "SSH_USERNAME": "your-username",
        "SSH_PRIVATE_KEY_PATH": "~/.ssh/id_rsa"
      }
    }
  }
}
```

### Codex

用命令行添加，会写入 `~/.codex/config.toml`：

```bash
codex mcp add ssh \
  --env SSH_HOST=your-server-ip \
  --env SSH_PORT=22 \
  --env SSH_USERNAME=your-username \
  --env SSH_PRIVATE_KEY_PATH=~/.ssh/id_rsa \
  -- node /path/to/ssh-mcp/dist/index.js
```

也可以直接编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.ssh]
command = "node"
args = ["/path/to/ssh-mcp/dist/index.js"]

[mcp_servers.ssh.env]
SSH_HOST = "your-server-ip"
SSH_PORT = "22"
SSH_USERNAME = "your-username"
SSH_PRIVATE_KEY_PATH = "~/.ssh/id_rsa"
```

### Cursor

编辑全局 `~/.cursor/mcp.json`，或在项目里创建 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-mcp/dist/index.js"],
      "env": {
        "SSH_HOST": "your-server-ip",
        "SSH_PORT": "22",
        "SSH_USERNAME": "your-username",
        "SSH_PRIVATE_KEY_PATH": "~/.ssh/id_rsa"
      }
    }
  }
}
```

Claude Desktop 的配置格式与 Cursor 相同，文件位置为 macOS 的 `~/Library/Application Support/Claude/claude_desktop_config.json` 或 Windows 的 `%APPDATA%\Claude\claude_desktop_config.json`。

### 路径说明

配置中的 `/path/to/ssh-mcp/dist/index.js` 需要替换为你机器上的真实绝对路径：

- **Windows**: `C:/Users/yourname/ssh-mcp/dist/index.js`
- **macOS**: `/Users/yourname/ssh-mcp/dist/index.js`
- **Linux**: `/home/yourname/ssh-mcp/dist/index.js`

> 提示：Windows 路径可以使用正斜杠 `/` 或双反斜杠 `\\`

本机运行目标为 Windows、macOS 和 Linux；远端需提供 SSH/SFTP 服务，命令按远端系统解释，不会自动转换成跨平台命令。Windows 的文件访问控制依赖系统 ACL，POSIX 的 `0600` 权限不等价于 Windows ACL。当前版本已在 macOS 验证，Windows 已由用户完成验证；因暂无 Linux 实机，Linux 尚未实机验证。

### 版本安装说明

本版本通过源码仓库分发，未发布到 npm。克隆仓库后，可在远端标签可用时检出 `v0.2.0`，执行 `npm ci` 和 `npm run build`，再按上文配置本地 `dist/index.js` 路径。不要使用 `npx ssh`，也不要假定 npm 上的同名包属于本项目。

## 环境变量

| 变量名 | 必填 | 说明 |
|--------|------|------|
| SSH_HOST | 是 | 服务器地址 |
| SSH_PORT | 否 | SSH 端口，默认 22 |
| SSH_USERNAME | 是 | 用户名 |
| SSH_PASSWORD | 否* | 密码认证 |
| SSH_PRIVATE_KEY | 否* | 私钥内容（原始 PEM 或其 Base64 编码） |
| SSH_PRIVATE_KEY_PATH | 否* | 私钥文件路径（支持 `~` 展开） |
| SSH_PASSPHRASE | 否 | 私钥密码 |
| SSH_TIMEOUT | 否 | 命令执行默认超时（毫秒），默认 30000；单次 `ssh_exec` 的 `timeout` 优先 |
| SSH_CONNECT_TIMEOUT | 否 | 连接超时（毫秒），默认 10000；自动连接和 `ssh_connect` 共用 |
| SSH_KEEPALIVE_INTERVAL | 否 | Keepalive 探测间隔（毫秒），默认 10000。设为 0 可禁用 |
| SSH_KEEPALIVE_COUNT | 否 | Keepalive 最大无响应次数，超过后判定连接死亡，默认 3 |
| SSH_MAX_RECONNECT_ATTEMPTS | 否 | 最大尝试次数（含首次），默认 3；正整数，设为 1 表示不重试，0 为无效配置 |
| SSH_RECONNECT_BASE_DELAY | 否 | 重连基础延迟（毫秒），默认 1000 |
| SSH_RECONNECT_MAX_DELAY | 否 | 重连最大延迟上限（毫秒），默认 10000 |
| SSH_STRICT_HOST_KEY_CHECKING | 否 | `yes`、`accept-new`、`no`。默认 `accept-new`：第一次见到主机时写入 known_hosts，密钥变化则拒绝连接 |
| SSH_KNOWN_HOSTS | 否 | known_hosts 文件路径，默认 `~/.ssh/known_hosts` |
| SSH_HOST_FINGERPRINT | 否 | 固定的 `SHA256:...` 主机指纹，不匹配则拒绝连接 |
| SSH_SFTP_TIMEOUT | 否 | SFTP 无进展超时（毫秒），默认 30000 |

> *注：密码、私钥内容、私钥路径三者至少提供一个

数值环境变量会校验完整整数及范围，不能带 `ms` 后缀或小数。命令/SFTP 超时范围为 1000–300000ms，连接超时为 1000–60000ms；keepalive 间隔为 0–3600000ms、次数为 1–100；重试次数为 1–1000，退避延迟为 1–600000ms。

SFTP 超时覆盖子系统初始化、读写和最终重命名等各阶段。读取收到数据、写入块获得服务器确认时会刷新无进展计时；不是整次传输的总时长限制，写入进度精度取决于应用写入块。

并发调用共享 SFTP 初始化，但各自的等待超时和取消互不影响；底层初始化另受 `SSH_SFTP_TIMEOUT`（默认 30000ms）限制，最后一个等待者退出时会关闭尚未完成的初始化。

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
- `timeout` (number, 可选): 命令执行默认超时（毫秒），未传时使用 `SSH_TIMEOUT`
- `connect_timeout` (number, 可选): 连接超时（毫秒），未传时使用 `SSH_CONNECT_TIMEOUT`
- `keepalive_interval` (number, 可选): Keepalive 探测间隔（毫秒），默认 10000
- `keepalive_count` (number, 可选): 最大无响应次数，默认 3
- `strict_host_key_checking` (string, 可选): `yes`、`accept-new` 或 `no`
- `known_hosts_path` (string, 可选): known_hosts 文件路径
- `host_fingerprint` (string, 可选): 要求匹配的 `SHA256:` 主机指纹

成功时返回 `session_id`、`host_fingerprint` 和 `host_key_type`。

已知主机切换密钥或算法时，请先通过可信渠道核对新指纹，再更新 known_hosts；不要通过设置 `no` 来自动绕过告警。

哈希主机记录会分别尝试调用时的原始拼写和全小写标记。哈希不可逆，无法恢复外部工具使用的其他混合大小写拼写；建议统一使用小写主机名生成及使用哈希记录，高保证场景另设固定指纹。

#### ssh_exec
执行远程命令。预配置服务器时无需提供 `session_id`。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `command` (string, 必填): 要执行的命令
- `timeout` (number, 可选): 本次命令的超时时间（毫秒），范围 1000–300000。超时后关闭执行通道，并且不会自动再执行这条命令。关闭通道不能保证已经脱离会话的远端进程一定停止。
- `background` (boolean, 可选): 为 true 时立即返回 `job_id`，命令继续在服务器上运行。用 `ssh_exec_poll` 查看输出，用 `ssh_exec_cancel` 关闭执行通道。后台任务只存在于当前 MCP 进程里。

命令开始后断线且未收到退出状态时返回错误，执行结果视为未知，不会自动重放；请先检查远端状态再决定是否重试。

```
示例：ssh_exec(command="ls -la /var/log")
```

#### ssh_exec_poll
读取后台任务当前的输出和状态。

**参数：**
- `job_id` (string, 必填): `ssh_exec` 返回的任务 ID
- `stdout_offset` (number, 可选): 从第几个字符开始返回 stdout

返回 `status`、`exit_code`、`next_stdout_offset`，以及新增的 stdout / stderr。

后台任务最多保留 32 个；终态任务最多保留 15 分钟（惰性清理），容量不足时可提前淘汰最旧终态任务，32 个均运行时拒绝新任务。断开会话会取消并移除其任务。`stdout_offset` 使用 JavaScript UTF-16 字符串下标，请直接复用返回的 `next_stdout_offset`。

#### ssh_exec_cancel
关闭后台任务的执行通道。通道关闭不保证已经脱离会话的远端进程一定停止。

**参数：**
- `job_id` (string, 必填): `ssh_exec` 返回的任务 ID

#### ssh_list_sessions
列出所有活跃的 SSH 会话。

#### ssh_disconnect
断开 SSH 连接。

**参数：**
- `session_id` (string, 可选): 要断开的会话 ID；省略时断开预配置的默认会话

### SFTP 文件操作

#### sftp_list
列出远程目录内容。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `path` (string, 可选): 目录路径，默认 `/`
- `timeout` (number, 可选): 无进展超时（毫秒）

```
示例：sftp_list(path="/home/user")
```

#### sftp_upload
上传本地文件到远程服务器。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `local_path` (string, 必填): 本地文件路径
- `remote_path` (string, 必填): 远程目标路径
- `timeout` (number, 可选): 无进展超时（毫秒）

```
示例：sftp_upload(local_path="/local/file.txt", remote_path="/home/user/file.txt")
```

#### sftp_download
从远程服务器下载文件到本地。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `remote_path` (string, 必填): 远程文件路径
- `local_path` (string, 必填): 本地目标路径
- `timeout` (number, 可选): 无进展超时（毫秒）

```
示例：sftp_download(remote_path="/var/log/syslog", local_path="/local/logs/syslog.txt")
```

#### sftp_read
按字节分段读取远程文件。空文件返回空内容。`utf8` 不会把一个字切成两半，继续读时使用返回的 `next_offset`。

如果 `limit` 小到放不下下一个完整 UTF-8 字符，会明确报错而非返回不前进的空页；请增大 `limit`（通常至少 4），或使用 `base64` 按原始字节读取。

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
- `timeout` (number, 可选): 无进展超时（毫秒）

```
示例：sftp_write(path="/home/user/test.txt", content="Hello World")
```

#### sftp_delete
删除远程文件或空目录。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `path` (string, 必填): 要删除的路径
- `timeout` (number, 可选): 无进展超时（毫秒）

```
示例：sftp_delete(path="/home/user/old-file.txt")
```

#### sftp_mkdir
创建远程目录。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `path` (string, 必填): 目录路径
- `timeout` (number, 可选): 无进展超时（毫秒）

```
示例：sftp_mkdir(path="/home/user/new-folder")
```

#### sftp_rename
重命名或移动远程文件/目录。

**参数：**
- `session_id` (string, 可选): 会话 ID
- `old_path` (string, 必填): 原路径
- `new_path` (string, 必填): 新路径
- `timeout` (number, 可选): 无进展超时（毫秒）

```
示例：sftp_rename(old_path="/home/user/old.txt", new_path="/home/user/new.txt")
```

## 使用示例

### 部署场景

```
用户：把这个项目部署到我的服务器
Agent：ssh_connect 连接服务器
    sftp_upload 上传构建产物
    ssh_exec 解压、重启服务
    ssh_exec 查看日志确认服务正常
```

### 预配置服务器模式

配置好环境变量后，服务启动时会自动连接，可以直接使用：

```
用户：查看服务器上的 /var/log 目录
Agent：调用 sftp_list(path="/var/log")

用户：查看 nginx 配置
Agent：调用 sftp_read(path="/etc/nginx/nginx.conf")

用户：重启 nginx 服务
Agent：调用 ssh_exec(command="systemctl restart nginx")

用户：上传本地的配置文件到服务器
Agent：调用 sftp_upload(local_path="/local/config/app.conf", remote_path="/etc/app/app.conf")
```

### 手动连接模式

```
用户：连接到我的服务器 192.168.1.100
Agent：调用 ssh_connect(host="192.168.1.100", username="your-username", password="xxx")
    返回 session_id

用户：执行 ls 命令
Agent：调用 ssh_exec(session_id="xxx", command="ls -la")

用户：断开连接
Agent：调用 ssh_disconnect(session_id="xxx")
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
| 命令输出 | stdout、stderr 各 25000 字符 | 分别截断，单次调用合计最多约 50000 字符 |

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
- 命令通道一旦打开，或上传、写入、创建目录、删除、重命名已经发到远端，失败后不会再执行一次，避免重复写入和临时文件残留
- 可通过 `SSH_MAX_RECONNECT_ATTEMPTS`、`SSH_RECONNECT_BASE_DELAY`、`SSH_RECONNECT_MAX_DELAY` 自定义

## 安全注意事项

**重要安全提示：**

1. **凭据保护**：密码和私钥仅在内存中保存，不会持久化到磁盘
2. **主机密钥**：默认 `accept-new`（首次信任，TOFU）。新主机的公钥写入 known_hosts；已知主机提供不匹配的密钥（包括切换算法）时拒绝连接。DNS 主机名匹配忽略 ASCII 大小写，支持否定模式；这不是完整的 OpenSSH 配置或证书校验实现，不支持 `@cert-authority`。需要固定目标时设置 `SSH_HOST_FINGERPRINT`；与 `yes` 同用时仍需预置 known_hosts。`no` 跳过文件比对（包括撤销记录），但仍检查固定指纹，只在明确接受风险时使用
3. **文件替换**：上传、下载和远程写入先写临时文件，核对字节数后再替换目标。远端不支持安全覆盖时返回错误，不先删除原文件。断线后的远端临时文件可能需要人工清理
4. **日志安全**：日志中不会打印密码和私钥内容
5. **会话清理**：服务关闭时会自动清理所有会话
6. **命令限制**：命令长度限制为 1000 字符，避免滥用
7. **输出限制**：stdout、stderr 各自超过 25000 字符会被截断
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
