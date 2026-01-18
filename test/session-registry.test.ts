import { describe, it, expect } from "vitest";
import { SessionRegistry } from "../src/services/session-registry";

describe("SessionRegistry", () => {
  it("creates and retrieves session", () => {
    const registry = new SessionRegistry();
    const session = registry.createSession({
      host: "127.0.0.1",
      port: 22,
      username: "root",
      client: {}
    });

    const record = registry.getSession(session.sessionId);
    expect(record?.host).toBe("127.0.0.1");
    expect(record?.username).toBe("root");
  });

  it("lists sessions", () => {
    const registry = new SessionRegistry();
    registry.createSession({
      host: "127.0.0.1",
      port: 22,
      username: "root",
      client: {}
    });

    const list = registry.listSessions();
    expect(list).toHaveLength(1);
  });

  it("removes session", () => {
    const registry = new SessionRegistry();
    const session = registry.createSession({
      host: "127.0.0.1",
      port: 22,
      username: "root",
      client: {}
    });

    const removed = registry.removeSession(session.sessionId);
    expect(removed?.sessionId).toBe(session.sessionId);
    expect(registry.listSessions()).toHaveLength(0);
  });
});
