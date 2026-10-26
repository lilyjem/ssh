#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CancelExecParamsSchema,
  ConnectParamsSchema,
  DisconnectParamsSchema,
  ExecParamsSchema,
  PollExecParamsSchema,
  SftpDeleteParamsSchema,
  SftpDownloadParamsSchema,
  SftpListParamsSchema,
  SftpMkdirParamsSchema,
  SftpReadParamsSchema,
  SftpRenameParamsSchema,
  SftpUploadParamsSchema,
  SftpWriteParamsSchema,
  SshToolHandlers,
} from "./tools/ssh-tools.js";
import { loadConfigFromEnv, hasPresetServer, validateServerConfig } from "./config.js";
import { log } from "./utils/log.js";

/** MCP 工具的错误返回，统一格式。 */
function toolError(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
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
  "Create a new SSH connection to a remote server. Returns a session_id and the accepted host key fingerprint. Host keys are checked against known_hosts (default accept-new: remember a new key, reject a changed key). If server is pre-configured via environment variables, this is optional.",
  ConnectParamsSchema.shape,
  async (params, extra) => {
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
      return toolError(err);
    }
  }
);

// ssh_exec: 执行远程命令
server.tool(
  "ssh_exec",
  "Execute a command on a connected SSH session. Returns stdout, stderr, and exit code. timeout applies to this call only; on timeout the execution channel is closed and the command is not run again. Set background=true to return a job_id immediately, then use ssh_exec_poll and ssh_exec_cancel. If session_id is omitted, uses the default pre-configured session.",
  ExecParamsSchema.shape,
  async (params, extra) => {
    try {
      log(`Executing command: ${params.command.slice(0, 50)}...`);
      const result = await handlers.exec(params, extra.signal);
      if ("background" in result) {
        log(`Background job started: ${result.job_id}`);
        return {
          content: [{ type: "text" as const, text: `job_id: ${result.job_id}\nstatus: ${result.status}\nUse ssh_exec_poll to read output and ssh_exec_cancel to stop it.` }],
        };
      }
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
      const error = err as Error & { timedOut?: boolean };
      const message = error.timedOut
        ? `Error: ${error.message}\ntimed_out: true`
        : `Error: ${error.message}`;
      log(`Execution failed: ${error.message}`);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  }
);

server.tool(
  "ssh_exec_poll",
  "Read the current output and status of a background command started with ssh_exec background=true.",
  PollExecParamsSchema.shape,
  async (params, extra) => {
    try {
      const result = await handlers.pollExec(params);
      let output = `job_id: ${result.job_id}\nstatus: ${result.status}\nexit_code: ${result.exit_code}\nnext_stdout_offset: ${result.next_stdout_offset}`;
      if (result.truncated) output += "\n[Output was truncated due to size limit]";
      if (result.stdout) output += `\n=== STDOUT ===\n${result.stdout}`;
      if (result.stderr) output += `\n=== STDERR ===\n${result.stderr}`;
      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      const message = (err as Error).message;
      return toolError(err);
    }
  }
);

server.tool(
  "ssh_exec_cancel",
  "Close the execution channel of a background command. This does not guarantee a detached remote process has stopped.",
  CancelExecParamsSchema.shape,
  async (params, extra) => {
    try {
      const result = await handlers.cancelExec(params);
      return {
        content: [{ type: "text" as const, text: `job_id: ${result.job_id}\nstatus: ${result.status}` }],
      };
    } catch (err) {
      const message = (err as Error).message;
      return toolError(err);
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
      return toolError(err);
    }
  }
);

// ssh_disconnect: 断开连接
server.tool(
  "ssh_disconnect",
  "Disconnect an SSH session and release resources. If session_id is omitted, disconnects the default session.",
  DisconnectParamsSchema.shape,
  async (params, extra) => {
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
      return toolError(err);
    }
  }
);

// ============ SFTP 工具 ============

// sftp_list: 列出远程目录
server.tool(
  "sftp_list",
  "List files and directories in a remote path. Returns file names, sizes, permissions, and modification times.",
  SftpListParamsSchema.shape,
  async (params, extra) => {
    try {
      log(`Listing directory: ${params.path}`);
      const result = await handlers.sftpList(params, extra.signal);
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
      return toolError(err);
    }
  }
);

// sftp_upload: 上传文件
server.tool(
  "sftp_upload",
  "Upload a local file to the remote server.",
  SftpUploadParamsSchema.shape,
  async (params, extra) => {
    try {
      log(`Uploading: ${params.local_path} -> ${params.remote_path}`);
      const result = await handlers.sftpUpload(params, extra.signal);
      log(`Upload completed: ${result.size} bytes`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Upload failed: ${message}`);
      return toolError(err);
    }
  }
);

// sftp_download: 下载文件
server.tool(
  "sftp_download",
  "Download a file from the remote server to local.",
  SftpDownloadParamsSchema.shape,
  async (params, extra) => {
    try {
      log(`Downloading: ${params.remote_path} -> ${params.local_path}`);
      const result = await handlers.sftpDownload(params, extra.signal);
      log(`Download completed: ${result.size} bytes`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Download failed: ${message}`);
      return toolError(err);
    }
  }
);

// sftp_read: 读取远程文件内容
server.tool(
  "sftp_read",
  "Read part of a remote file. Use offset and next_offset to page through it. encoding=utf8 avoids splitting a character; encoding=base64 returns exact bytes.",
  SftpReadParamsSchema.shape,
  async (params, extra) => {
    try {
      log(`Reading file: ${params.path}`);
      const result = await handlers.sftpRead(params, extra.signal);
      log(`Read ${result.bytes_read} bytes, truncated: ${result.truncated}`);

      let output = `=== File: ${result.path} (${result.size} bytes, offset ${result.offset}, next_offset ${result.next_offset}) ===\n`;
      if (result.truncated) {
        output += "[Content truncated. Read again from next_offset.]\n";
      }
      output += "\n" + result.content;

      return {
        content: [{ type: "text" as const, text: output }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Read failed: ${message}`);
      return toolError(err);
    }
  }
);

// sftp_write: 写入远程文件
server.tool(
  "sftp_write",
  "Write content to a remote file. Creates the file if it doesn't exist, overwrites if it does.",
  SftpWriteParamsSchema.shape,
  async (params, extra) => {
    try {
      log(`Writing file: ${params.path}`);
      const result = await handlers.sftpWrite(params, extra.signal);
      log(`Written ${result.size} bytes`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Write failed: ${message}`);
      return toolError(err);
    }
  }
);

// sftp_delete: 删除文件或目录
server.tool(
  "sftp_delete",
  "Delete a file or empty directory on the remote server.",
  SftpDeleteParamsSchema.shape,
  async (params, extra) => {
    try {
      log(`Deleting: ${params.path}`);
      const result = await handlers.sftpDelete(params, extra.signal);
      log(`Deleted: ${result.path}`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Delete failed: ${message}`);
      return toolError(err);
    }
  }
);

// sftp_mkdir: 创建目录
server.tool(
  "sftp_mkdir",
  "Create a directory on the remote server.",
  SftpMkdirParamsSchema.shape,
  async (params, extra) => {
    try {
      log(`Creating directory: ${params.path}`);
      const result = await handlers.sftpMkdir(params, extra.signal);
      log(`Created: ${result.path}`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Mkdir failed: ${message}`);
      return toolError(err);
    }
  }
);

// sftp_rename: 重命名/移动文件
server.tool(
  "sftp_rename",
  "Rename or move a file/directory on the remote server.",
  SftpRenameParamsSchema.shape,
  async (params, extra) => {
    try {
      log(`Renaming: ${params.old_path} -> ${params.new_path}`);
      const result = await handlers.sftpRename(params, extra.signal);
      log(`Renamed to: ${result.path}`);

      return {
        content: [{ type: "text" as const, text: result.message }],
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`Rename failed: ${message}`);
      return toolError(err);
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

  // 处理进程退出信号和客户端正常关闭 stdin
  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");
    await handlers.cleanup();
    log("Cleanup complete");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.stdin.on("end", () => { void cleanup(); });

  const notifyClose = transport.onclose;
  transport.onclose = () => {
    notifyClose?.();
    void cleanup();
  };
}

// 运行主函数
main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
