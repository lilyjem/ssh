# SSH MCP Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local MCP server that manages SSH sessions and executes commands securely via stdio.

**Architecture:** TypeScript MCP server with Zod-validated tool inputs, an in-memory session registry, and an ssh2-based execution layer. Tools expose connect/exec/list/disconnect with consistent output and error handling.

**Tech Stack:** Node.js 18+, TypeScript 5, @modelcontextprotocol/sdk, ssh2, zod, vitest.

---

### Task 1: Project scaffolding and test runner

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `README.md`
- Create: `src/constants.ts`
- Create: `src/types.ts`

**Step 1: Write the failing test**
Create a placeholder test file to verify the test runner is wired (it will fail because the module is missing).
```typescript
import { describe, it, expect } from "vitest";
import { CHARACTER_LIMIT } from "../src/constants";

describe("constants", () => {
  it("exports CHARACTER_LIMIT", () => {
    expect(CHARACTER_LIMIT).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npm test`
Expected: FAIL with "Cannot find module '../src/constants'".

**Step 3: Write minimal implementation**
Create `src/constants.ts` exporting `CHARACTER_LIMIT`.

**Step 4: Run test to verify it passes**
Run: `npm test`
Expected: PASS.

**Step 5: Commit**
```bash
git add package.json tsconfig.json vitest.config.ts README.md src/constants.ts src/types.ts test/constants.test.ts
git commit -m "chore: scaffold project and tests"
```

### Task 2: Validation utilities and session registry (TDD)

**Files:**
- Create: `src/utils/validation.ts`
- Create: `src/services/session-registry.ts`
- Create: `test/validation.test.ts`
- Create: `test/session-registry.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, it, expect } from "vitest";
import { sanitizeCommand } from "../src/utils/validation";

describe("sanitizeCommand", () => {
  it("rejects empty command", () => {
    expect(() => sanitizeCommand("")).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npm test -- test/validation.test.ts`
Expected: FAIL with "Cannot find module '../src/utils/validation'".

**Step 3: Write minimal implementation**
Implement `sanitizeCommand` and a `SessionRegistry` with add/get/list/remove.

**Step 4: Run test to verify it passes**
Run: `npm test`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/utils/validation.ts src/services/session-registry.ts test/validation.test.ts test/session-registry.test.ts
git commit -m "feat: add validation and session registry"
```

### Task 3: SSH execution layer with in-process test server (TDD)

**Files:**
- Create: `src/services/ssh-client.ts`
- Create: `test/ssh-server.fixture.ts`
- Create: `test/ssh-exec.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, it, expect } from "vitest";
import { createTestSshServer } from "./ssh-server.fixture";
import { SshClient } from "../src/services/ssh-client";

describe("SshClient exec", () => {
  it("executes a command and returns stdout", async () => {
    const server = await createTestSshServer();
    const client = new SshClient(server.config);
    await client.connect();
    const result = await client.execCommand("echo ok");
    expect(result.stdout).toBe("ok\n");
    await client.close();
    await server.close();
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npm test -- test/ssh-exec.test.ts`
Expected: FAIL with "Cannot find module '../src/services/ssh-client'".

**Step 3: Write minimal implementation**
Implement `SshClient` with `connect`, `execCommand`, `close`, plus a test SSH server fixture using ssh2 `Server`.

**Step 4: Run test to verify it passes**
Run: `npm test`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/services/ssh-client.ts test/ssh-server.fixture.ts test/ssh-exec.test.ts
git commit -m "feat: add ssh execution layer with tests"
```

### Task 4: MCP tool handlers and server entry (TDD)

**Files:**
- Create: `src/tools/ssh-tools.ts`
- Create: `src/index.ts`
- Create: `test/tool-handlers.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, it, expect } from "vitest";
import { createHandlers } from "../src/tools/ssh-tools";

describe("handlers", () => {
  it("rejects exec for missing session", async () => {
    const handlers = createHandlers();
    await expect(handlers.exec({ session_id: "missing", command: "ls" })).rejects.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npm test -- test/tool-handlers.test.ts`
Expected: FAIL with "Cannot find module '../src/tools/ssh-tools'".

**Step 3: Write minimal implementation**
Implement handler functions, register MCP tools in `src/index.ts` using `server.registerTool`, and wire validation + session registry.

**Step 4: Run test to verify it passes**
Run: `npm test`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/tools/ssh-tools.ts src/index.ts test/tool-handlers.test.ts
git commit -m "feat: register ssh tools and server entry"
```

### Task 5: Documentation and build verification

**Files:**
- Update: `README.md`
- Update: `package.json`

**Step 1: Write the failing test**
Add a README snippet test if desired (optional). If not, skip to build verification.

**Step 2: Run test to verify it fails**
If a test was added, run `npm test` and confirm failure; otherwise skip.

**Step 3: Write minimal implementation**
Document tool usage, setup, and security notes; ensure scripts include `build` and `start`.

**Step 4: Run test to verify it passes**
Run: `npm test`
Expected: PASS.

**Step 5: Commit**
```bash
git add README.md package.json
git commit -m "docs: add usage and build verification"
```
