import { existsSync } from "node:fs";
import { appendEvent } from "../core/events/index.ts";

export default async function(pi: any) {
  // Session state
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();

  // Track reads
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.tool === "read" || event.toolName === "read") {
      const filePath = event.input?.file_path || event.input?.path || event.args?.file_path || event.args?.path;
      if (filePath) {
        readFiles.add(filePath);
      }
    }
  });

  // Hook 1: Read-before-write check (loosened)
  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = event.tool || event.toolName;
    if (toolName === "edit" || toolName === "write") {
      const filePath = event.input?.file_path || event.input?.path || event.args?.file_path || event.args?.path;
      if (filePath && existsSync(filePath) && !readFiles.has(filePath)) {
        console.error(`[discipline] WARN: Modifying "${filePath}" without reading it first in this session`);
        appendEvent("hook_warn", {
          rule: "read-before-write",
          file: filePath,
          message: "File modified without prior read in session",
        });
      }
      // Always allow (松绑) — never block
    }
  });

  // Hook 2: Diff observation (informational only)
  pi.on("tool_result", async (event: any, ctx: any) => {
    const toolName = event.tool || event.toolName;
    if (toolName === "edit" || toolName === "write") {
      const filePath = event.input?.file_path || event.input?.path || event.args?.file_path || event.args?.path;
      if (filePath) {
        modifiedFiles.add(filePath);
      }
      if (modifiedFiles.size > 5) {
        console.error(`[discipline] WARN: ${modifiedFiles.size} files modified this session — consider scoping changes`);
        appendEvent("hook_warn", {
          rule: "diff-scope-observation",
          filesModified: modifiedFiles.size,
          files: [...modifiedFiles],
        });
      }
    }
  });

  // Hook 3: Fail-loud (strict)
  pi.on("tool_result", async (event: any, ctx: any) => {
    const toolName = event.tool || event.toolName;
    if (toolName === "bash") {
      const exitCode = event.details?.exitCode ?? event.exitCode ?? event.error?.exitCode;
      const isError = event.isError || event.error || (exitCode !== undefined && exitCode !== 0);
      if (isError) {
        appendEvent("hook_fail_loud", {
          rule: "fail-loud",
          tool: toolName,
          exitCode: exitCode ?? "unknown",
          message: "Non-zero exit code detected",
        });
        // Note: we log but don't need to block — the error is already visible
        // The purpose is to ensure it's recorded in events.jsonl for audit
      }
    }
  });
}
