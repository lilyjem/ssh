#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SshToolHandlers } from "./tools/ssh-tools.js";
import { loadConfigFromEnv, hasPresetServer, validateServerConfig } from "./config.js";

// 日志输出到 stderr，避免干扰 MCP 协议通信
function log(message: string): void {
  console.error(`[SSH-MCP] ${new Date().toISOString()} ${message}`);
}

// 加载配置
const globalConfig = loadConfigFromEnv();

// 创建 MCP 服务器实例
const server = new McpServer({
  name: "ssh-mcp-server",
  version: "0.1.0",
});

// 创建 SSH 工具处理器（传入全局配置）
const handlers = new SshToolHandlers(globalConfig);

// ============ 注册 MCP 工具 ============

// ssh_connect: 创建 SSH 连接
server.tool(
  "ssh_connect",
  "Create a new SSH connection to a remote server. Returns a session_id for subsequent operations. If server is pre-configured via environment variables, this is optional.",
  {
    host: z.string().describe("Remote server hostname or IP address"),
    port: z.number().int().min(1).max(65535).default(22).describe("SSH port (default: 22)"),
    username: z.string().describe("SSH username"),
    password: z.string().optional().describe("Password for authentication"),
    private_key: z.string().optional().describe("Private key content (PEM format)"),
    private_key_path: z.string().optional().describe("Path to private key file"),
    passphrase: z.string().optional().describe("Passphrase for encrypted private key"),
    timeout: z.number().int().min(1000).max(300000).optional().describe("Command execution timeout in ms (default: 30000)"),
    connect_timeout: z.number().int().min(1000).max(60000).optional().describe("Connection timeout in ms (default: 10000)"),
  },
  async (params) => {
    try {
      log(`Connecting to ${params.username}@${params.host}:${params.port}`);
      const result = await handlers.connect(params);
      log(`Connected: session_id=${result.session_id}`);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Connection failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// ssh_exec: 执行远程命令
server.tool(
  "ssh_exec",
  "Execute a command on a connected SSH session. Returns stdout, stderr, and exit code. If session_id is omitted, uses the default pre-configured session.",
  {
    session_id: z.string().optional().describe("Session ID from ssh_connect (optional if using pre-configured server)"),
    command: z.string().describe("Command to execute on the remote server"),
    timeout: z.number().int().min(1000).max(300000).optional().describe("Override command timeout in ms"),
  },
  async (params) => {
    try {
      log(`Executing command: ${params.command.slice(0, 50)}...`);
      const result = await handlers.exec(params);
      log(`Command completed: exit_code=${result.exit_code}, truncated=${result.truncated}`);

      let output = "";
      if (result.stdout) {
        output += `=== STDOUT ===\n${result.stdout}\n`;
      }
      if (result.stderr) {
        output += `=== STDERR ===\n${result.stderr}\n`;
      }
      output += `=== EXIT CODE: ${result.exit_code} ===`;
      if (result.truncated) {
        output += "\n[Output was truncated due to size limit]";
      }

      return {
        content: [{ type: "text" as const, text: output }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Execution failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// ssh_list_sessions: 列出所有会话
server.tool(
  "ssh_list_sessions",
  "List all active SSH sessions with their connection details.",
  {},
  async () => {
    try {
      const result = handlers.listSessions();
      log(`Listed ${result.count} sessions`);

      if (result.count === 0) {
        return {
          content: [{ type: "text" as const, text: "No active SSH sessions." }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`List sessions failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// ssh_disconnect: 断开连接
server.tool(
  "ssh_disconnect",
  "Disconnect an SSH session and release resources. If session_id is omitted, disconnects the default session.",
  {
    session_id: z.string().optional().describe("Session ID to disconnect (optional if using pre-configured server)"),
  },
  async (params) => {
    try {
      log(`Disconnecting session`);
      const result = await handlers.disconnect(params);
      log(`Disconnected: ${result.message}`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Disconnect failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// ============ SFTP 工具 ============

// sftp_list: 列出远程目录
server.tool(
  "sftp_list",
  "List files and directories in a remote path. Returns file names, sizes, permissions, and modification times.",
  {
    session_id: z.string().optional().describe("Session ID (optional if using pre-configured server)"),
    path: z.string().default("/").describe("Remote directory path to list (default: /)"),
  },
  async (params) => {
    try {
      log(`Listing directory: ${params.path}`);
      const result = await handlers.sftpList(params);
      log(`Listed ${result.count} items`);

      // 格式化输出
      let output = `Directory: ${result.path}\n`;
      output += `Total: ${result.count} items\n\n`;

      for (const file of result.files) {
        const typeChar = file.isDirectory ? "d" : "-";
        const sizeStr = file.isDirectory ? "<DIR>" : `${file.size}`;
        output += `${typeChar}${file.permissions}  ${sizeStr.padStart(10)}  ${file.modifyTime.slice(0, 19)}  ${file.filename}\n`;
      }

      return {
        content: [{ type: "text" as const, text: output }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`List failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// sftp_upload: 上传文件
server.tool(
  "sftp_upload",
  "Upload a local file to the remote server.",
  {
    session_id: z.string().optional().describe("Session ID (optional if using pre-configured server)"),
    local_path: z.string().describe("Local file path to upload"),
    remote_path: z.string().describe("Remote destination path"),
  },
  async (params) => {
    try {
      log(`Uploading: ${params.local_path} -> ${params.remote_path}`);
      const result = await handlers.sftpUpload(params);
      log(`Upload completed: ${result.size} bytes`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Upload failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// sftp_download: 下载文件
server.tool(
  "sftp_download",
  "Download a file from the remote server to local.",
  {
    session_id: z.string().optional().describe("Session ID (optional if using pre-configured server)"),
    remote_path: z.string().describe("Remote file path to download"),
    local_path: z.string().describe("Local destination path"),
  },
  async (params) => {
    try {
      log(`Downloading: ${params.remote_path} -> ${params.local_path}`);
      const result = await handlers.sftpDownload(params);
      log(`Download completed: ${result.size} bytes`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Download failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// sftp_read: 读取远程文件内容
server.tool(
  "sftp_read",
  "Read the content of a remote text file.",
  {
    session_id: z.string().optional().describe("Session ID (optional if using pre-configured server)"),
    path: z.string().describe("Remote file path to read"),
  },
  async (params) => {
    try {
      log(`Reading file: ${params.path}`);
      const result = await handlers.sftpRead(params);
      log(`Read ${result.size} bytes, truncated: ${result.truncated}`);

      let output = `=== File: ${result.path} (${result.size} bytes) ===\n`;
      if (result.truncated) {
        output += "[Content truncated due to size limit]\n";
      }
      output += "\n" + result.content;

      return {
        content: [{ type: "text" as const, text: output }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Read failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// sftp_write: 写入远程文件
server.tool(
  "sftp_write",
  "Write content to a remote file. Creates the file if it doesn't exist, overwrites if it does.",
  {
    session_id: z.string().optional().describe("Session ID (optional if using pre-configured server)"),
    path: z.string().describe("Remote file path to write"),
    content: z.string().describe("Content to write to the file"),
  },
  async (params) => {
    try {
      log(`Writing file: ${params.path}`);
      const result = await handlers.sftpWrite(params);
      log(`Written ${result.size} bytes`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Write failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// sftp_delete: 删除文件或目录
server.tool(
  "sftp_delete",
  "Delete a file or empty directory on the remote server.",
  {
    session_id: z.string().optional().describe("Session ID (optional if using pre-configured server)"),
    path: z.string().describe("Remote path to delete"),
    recursive: z.boolean().default(false).describe("Recursively delete directory contents (not yet implemented)"),
  },
  async (params) => {
    try {
      log(`Deleting: ${params.path}`);
      const result = await handlers.sftpDelete(params);
      log(`Deleted: ${result.path}`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Delete failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// sftp_mkdir: 创建目录
server.tool(
  "sftp_mkdir",
  "Create a directory on the remote server.",
  {
    session_id: z.string().optional().describe("Session ID (optional if using pre-configured server)"),
    path: z.string().describe("Remote directory path to create"),
  },
  async (params) => {
    try {
      log(`Creating directory: ${params.path}`);
      const result = await handlers.sftpMkdir(params);
      log(`Created: ${result.path}`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Mkdir failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// sftp_rename: 重命名/移动文件
server.tool(
  "sftp_rename",
  "Rename or move a file/directory on the remote server.",
  {
    session_id: z.string().optional().describe("Session ID (optional if using pre-configured server)"),
    old_path: z.string().describe("Current path of the file/directory"),
    new_path: z.string().describe("New path for the file/directory"),
  },
  async (params) => {
    try {
      log(`Renaming: ${params.old_path} -> ${params.new_path}`);
      const result = await handlers.sftpRename(params);
      log(`Renamed to: ${result.path}`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Rename failed: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);

// ============ 启动服务器 ============

async function main(): Promise<void> {
  log("Starting SSH MCP Server...");

  // 检查是否有预配置的服务器
  if (hasPresetServer(globalConfig)) {
    log(`Pre-configured server found: ${globalConfig.server!.username}@${globalConfig.server!.host}:${globalConfig.server!.port}`);
    
    // 验证配置
    const validationError = validateServerConfig(globalConfig.server!);
    if (validationError) {
      log(`Warning: Server configuration incomplete - ${validationError}`);
    } else {
      // 尝试自动连接
      try {
        const sessionId = await handlers.autoConnect();
        log(`Auto-connected successfully: session_id=${sessionId}`);
      } catch (err) {
        log(`Auto-connect failed: ${(err as Error).message}`);
        log("You can still connect manually using ssh_connect");
      }
    }
  } else {
    log("No pre-configured server. Use ssh_connect to establish a connection.");
  }

  // 创建 stdio 传输
  const transport = new StdioServerTransport();

  // 连接服务器
  await server.connect(transport);

  log("SSH MCP Server is running");

  // 处理进程退出信号
  const cleanup = async () => {
    log("Shutting down...");
    await handlers.cleanup();
    log("Cleanup complete");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// 运行主函数
main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
