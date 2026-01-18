import { Server, utils } from "ssh2";
import { readFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { generateKeyPairSync } from "crypto";

// 测试用 SSH 服务器配置
export interface TestServerConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

// 测试服务器实例
export interface TestSshServer {
  config: TestServerConfig;
  close: () => Promise<void>;
}

/**
 * 生成测试用的 RSA 密钥对（PEM 格式）
 */
function generateTestHostKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs1",
      format: "pem",
    },
    publicKeyEncoding: {
      type: "pkcs1",
      format: "pem",
    },
  });
  return privateKey;
}

/**
 * 创建一个用于测试的 SSH 服务器
 * 使用 ssh2 的 Server 类在本地启动一个最小化的 SSH 服务
 * 支持密码认证和简单的命令执行
 */
export async function createTestSshServer(): Promise<TestSshServer> {
  return new Promise((resolve, reject) => {
    const config: TestServerConfig = {
      host: "127.0.0.1",
      port: 0, // 让系统分配端口
      username: "testuser",
      password: "testpass",
    };

    // 生成测试用的主机密钥
    const hostKey = generateTestHostKey();

    const server = new Server(
      {
        hostKeys: [hostKey],
      },
      (client) => {
        // 处理客户端连接
        client.on("authentication", (ctx) => {
          // 验证用户名和密码
          if (
            ctx.method === "password" &&
            ctx.username === config.username &&
            ctx.password === config.password
          ) {
            ctx.accept();
          } else if (ctx.method === "none") {
            // 告诉客户端需要密码认证
            ctx.reject(["password"]);
          } else {
            ctx.reject();
          }
        });

        client.on("ready", () => {
          // 客户端认证成功，等待会话请求
          client.on("session", (accept) => {
            const session = accept();

            session.on("exec", (accept, reject, info) => {
              // 执行命令
              const channel = accept();
              const command = info.command;

              // 使用 shell 执行命令
              // Windows 使用 cmd，Unix 使用 sh
              const isWindows = process.platform === "win32";
              const shell = isWindows ? "cmd" : "sh";
              const shellArgs = isWindows ? ["/c", command] : ["-c", command];

              const child = spawn(shell, shellArgs, {
                stdio: ["pipe", "pipe", "pipe"],
              });

              // 将子进程的输出转发到 SSH 通道
              child.stdout.on("data", (data: Buffer) => {
                channel.write(data);
              });

              child.stderr.on("data", (data: Buffer) => {
                channel.stderr.write(data);
              });

              child.on("close", (code) => {
                channel.exit(code ?? 0);
                channel.end();
              });

              child.on("error", (err) => {
                channel.stderr.write(`Error: ${err.message}\n`);
                channel.exit(1);
                channel.end();
              });
            });

            session.on("shell", (accept) => {
              // 简单的 shell 会话支持（可选）
              const channel = accept();
              channel.write("Test SSH Server Shell\r\n");
              channel.on("data", (data: Buffer) => {
                // 回显输入
                channel.write(data);
              });
            });
          });
        });

        client.on("error", (err) => {
          // 忽略客户端错误
          console.error("[TestSSHServer] Client error:", err.message);
        });
      }
    );

    server.on("error", (err) => {
      reject(err);
    });

    // 监听随机端口
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        config.port = address.port;
      }

      resolve({
        config,
        close: () => {
          return new Promise<void>((resolveClose) => {
            server.close(() => {
              resolveClose();
            });
          });
        },
      });
    });
  });
}
