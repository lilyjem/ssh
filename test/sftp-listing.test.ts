import type { Client, SFTPWrapper } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { SftpClient } from "../src/services/sftp-client.js";

function listingClient(entries: unknown[]) {
  const wrapper = {
    end: vi.fn(),
    readdir: (_path: string, callback: (err: Error | null, list: unknown[]) => void) => {
      callback(null, entries);
    },
  };
  const sshClient = {
    sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => {
      callback(null, wrapper as unknown as SFTPWrapper);
    },
  } as unknown as Client;
  return new SftpClient(sshClient);
}

describe("SFTP 目录项可选属性", () => {
  it("缺少 attrs/mtime 时不抛 RangeError，并提供稳定的默认值", async () => {
    const client = listingClient([
      {
        filename: "missing-mtime.txt",
        longname: "missing-mtime.txt",
        attrs: { mode: 0o100644, uid: 1, gid: 2, size: 3, atime: 100 },
      },
      { filename: "missing-attrs.txt", longname: "missing-attrs.txt" },
      {
        filename: "bad-mtime.txt",
        longname: "bad-mtime.txt",
        attrs: { mode: 0o100644, mtime: Number.MAX_VALUE },
      },
      {
        filename: "normal.txt",
        longname: "normal.txt",
        attrs: { mode: 0o100644, uid: 0, gid: 0, size: 9, atime: 0, mtime: 1700000000 },
      },
    ]);
    await client.init();

    const result = await client.listDirectory("/");

    expect(result.count).toBe(4);
    const byName = new Map(result.files.map((file) => [file.filename, file]));
    expect(byName.get("missing-mtime.txt")?.modifyTime).toBe("");
    expect(byName.get("missing-mtime.txt")?.size).toBe(3);
    expect(byName.get("missing-mtime.txt")?.permissions).toBe("rw-r--r--");
    expect(byName.get("missing-attrs.txt")?.modifyTime).toBe("");
    expect(byName.get("missing-attrs.txt")?.isFile).toBe(false);
    expect(byName.get("bad-mtime.txt")?.modifyTime).toBe("");
    expect(byName.get("normal.txt")?.modifyTime).toBe("2023-11-14T22:13:20.000Z");
  });
});
