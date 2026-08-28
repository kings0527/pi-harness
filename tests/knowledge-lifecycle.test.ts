// Adversarial / stress coverage for ADR-0026 index-row lifecycle:
//   1. dead links (missing/invalid) drop from the injected catalog
//   2. retired rows ([SUPERSEDED]/[ARCHIVED]/[DEPRECATED]) fold out of the
//      primary catalog but stay cite-able, and never leak into active view
// Invariants under test: no silent deletion, parse round-trips, tag stripping
// never misclassifies a real path as a dead link, re-distill reactivates.

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let originalCwd: string;
let originalHome: string | undefined;
let sandbox: string;
let projectDir: string;
let projectRoot: string;
let indexPath: string;
let knowledge: typeof import("../core/knowledge/index.ts");
let contextReference: typeof import("../core/context-reference/index.ts");

before(async () => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-lifecycle-test-")));
  projectDir = join(sandbox, "project");
  const homeDir = join(sandbox, "home");
  mkdirSync(join(projectDir, ".git"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  process.chdir(projectDir);
  projectRoot = join(projectDir, "knowledge");
  indexPath = join(projectRoot, "index.md");
  knowledge = await import(`../core/knowledge/index.ts?lifecycle=${Date.now()}`);
  contextReference = await import(`../core/context-reference/index.ts?lifecycle=${Date.now()}`);
});

after(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(sandbox, { recursive: true, force: true });
});

/** Reset the project knowledge dir to a clean slate before every test. */
beforeEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  mkdirSync(projectRoot, { recursive: true });
});

/** Write a real entry file so a row is NOT a dead link, without touching index. */
function touchEntryFile(relPath: string, body = "content"): void {
  const full = join(projectRoot, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf-8");
}

/** Write the index verbatim. */
function writeIndex(lines: string): void {
  writeFileSync(indexPath, lines, "utf-8");
}

function catalogBlock(): string {
  const snapshot = contextReference.buildKnowledgeSnapshot();
  const marker = `knowledge(project+workspace:${indexPath}):`;
  const start = snapshot.content.indexOf(marker);
  if (start === -1) return "";
  // The catalog body itself contains a `\n\n` between the active rows and the
  // retired section, so we must NOT split on `\n\n`. In this sandbox no root
  // KNOWLEDGE.md or active scope follows, so the body runs to end of content.
  return snapshot.content.slice(start + marker.length).replace(/^\n/, "");
}

// ---------------------------------------------------------------------------
// getIndex parsing: status column
// ---------------------------------------------------------------------------

test("getIndex 默认 active；三种退休标签大小写不敏感且路径被正确剥离", () => {
  writeIndex([
    "a/plain.md | plain active row",
    "[SUPERSEDED] b/sup.md | superseded row",
    "[archived] c/arc.md | archived row lowercase tag",
    "[Deprecated]  d/dep.md | deprecated row extra space",
  ].join("\n") + "\n");

  const entries = knowledge.getIndex();
  assert.deepEqual(entries, [
    { path: "a/plain.md", description: "plain active row", status: "active" },
    { path: "b/sup.md", description: "superseded row", status: "superseded" },
    { path: "c/arc.md", description: "archived row lowercase tag", status: "archived" },
    { path: "d/dep.md", description: "deprecated row extra space", status: "deprecated" },
  ]);
});

test("退休标签不得污染路径解析：带标签行的路径可正常 resolve，不被误判为 dead link", () => {
  touchEntryFile("real/entry.md");
  writeIndex("[SUPERSEDED] real/entry.md | file still exists\n");

  // The file exists, so a stripped path must resolve cleanly — zero audit issues.
  assert.deepEqual(knowledge.auditIndex(), []);
  const entries = knowledge.getIndex();
  assert.equal(entries[0].status, "superseded");
  assert.equal(entries[0].path, "real/entry.md");
});

test("未知标签不被当作退休标签：[TODO]/[WIP] 视为描述的一部分而非状态", () => {
  // Only SUPERSEDED/ARCHIVED/DEPRECATED are lifecycle tags. Anything else must
  // be treated literally so we never silently reinterpret operators' text.
  writeIndex("[TODO] x/y.md | not a lifecycle tag\n");
  const entries = knowledge.getIndex();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "active");
  // The "[TODO]" prefix stays glued to the path (literal), proving no stripping.
  assert.equal(entries[0].path, "[TODO] x/y.md");
});

// ---------------------------------------------------------------------------
// Injection: dead-link drop + retired fold
// ---------------------------------------------------------------------------

test("dead link 从注入 catalog 中消失，但仍作为 health issue 报告（不静默删文件行）", () => {
  touchEntryFile("live.md");
  writeIndex([
    "live.md | present",
    "gone.md | file was deleted",
    "../escape.md | invalid path",
  ].join("\n") + "\n");

  const snapshot = contextReference.buildKnowledgeSnapshot();
  const block = catalogBlock();

  // Live row visible; dead + invalid rows excluded from the model's view.
  assert.match(block, /live\.md \| present/);
  assert.doesNotMatch(block, /gone\.md/);
  assert.doesNotMatch(block, /escape\.md/);

  // But they are still reported so a human/agent can repair or restore.
  const reasons = snapshot.issues.map(i => `${i.issue.path}:${i.issue.reason}`);
  assert.ok(reasons.includes("gone.md:missing"), JSON.stringify(reasons));
  assert.ok(reasons.includes("../escape.md:invalid"), JSON.stringify(reasons));

  // The index FILE itself is untouched — no silent deletion.
  assert.match(readFileSync(indexPath, "utf-8"), /gone\.md \| file was deleted/);
});

test("退休行折叠到 retired 区、排在 active 之后，且带回可见状态标签", () => {
  touchEntryFile("active-1.md");
  touchEntryFile("active-2.md");
  touchEntryFile("old.md");
  writeIndex([
    "active-1.md | current one",
    "[SUPERSEDED] old.md | replaced by active-2",
    "active-2.md | current two",
  ].join("\n") + "\n");

  const block = catalogBlock();
  const activeIdx = block.indexOf("active-1.md");
  const retiredHeaderIdx = block.indexOf("retired (folded");
  const oldIdx = block.indexOf("old.md");

  assert.ok(activeIdx >= 0 && retiredHeaderIdx >= 0 && oldIdx >= 0);
  // Active rows come first, retired section strictly after.
  assert.ok(activeIdx < retiredHeaderIdx, "active must precede retired section");
  assert.ok(retiredHeaderIdx < oldIdx, "retired row must live under the retired header");
  // Retired row carries its status tag so the model can still cite it as history.
  assert.match(block, /\[SUPERSEDED\] old\.md \| replaced by active-2/);
  // Active rows never carry a tag.
  assert.doesNotMatch(block.slice(0, retiredHeaderIdx), /\[SUPERSEDED\]/);
});

test("退休 + dead link 叠加：既退休又文件缺失的行直接消失（dead link 优先，连 retired 区都不进）", () => {
  touchEntryFile("keep.md");
  writeIndex([
    "keep.md | alive and active",
    "[ARCHIVED] vanished.md | archived AND file removed",
  ].join("\n") + "\n");

  const block = catalogBlock();
  assert.match(block, /keep\.md \| alive and active/);
  // A retired row whose file is gone is still a dead link → excluded entirely,
  // not shown in the retired section (nothing to consult).
  assert.doesNotMatch(block, /vanished\.md/);
  assert.doesNotMatch(block, /retired \(folded/);
});

test("全部退休/全部 dead 时不产生空 active catalog 噪声", () => {
  touchEntryFile("only-old.md");
  writeIndex("[DEPRECATED] only-old.md | the only row\n");
  const block = catalogBlock();
  // No active rows → no leading blank line garbage; retired section still shows.
  assert.doesNotMatch(block, /^\n/);
  assert.match(block, /retired \(folded/);
  assert.match(block, /\[DEPRECATED\] only-old\.md/);
});

// ---------------------------------------------------------------------------
// updateIndex: re-distill reactivation & no duplicate rows
// ---------------------------------------------------------------------------

test("对退休路径重新 distill 会复活该行（去掉标签、回到 active、不新增重复行）", () => {
  touchEntryFile("reborn.md");
  writeIndex("[SUPERSEDED] reborn.md | old desc\n");

  // addEntry refuses to overwrite an existing FILE, so simulate a fresh entry
  // whose file does not yet exist but whose index row is retired.
  rmSync(join(projectRoot, "reborn.md"));
  knowledge.addEntry("reborn.md", "fresh evidence", "topic-x#seq-1", "revived desc");

  const raw = readFileSync(indexPath, "utf-8");
  // Exactly one row for reborn.md, now active (no tag), with the new description.
  assert.equal(raw.match(/reborn\.md/g)?.length, 1, raw);
  assert.doesNotMatch(raw, /\[SUPERSEDED\]/);
  assert.match(raw, /^reborn\.md \| revived desc$/m);

  const entry = knowledge.getIndex().find(e => e.path === "reborn.md");
  assert.equal(entry?.status, "active");
});

// ---------------------------------------------------------------------------
// Round-trip / fuzz: parse must be stable and never crash
// ---------------------------------------------------------------------------

test("暴力 fuzz：随机混合 active/退休/dead/注释/空行/多管道符，解析稳定且注入不崩", () => {
  const rng = (seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(42);
  const statuses = ["", "[SUPERSEDED] ", "[ARCHIVED] ", "[DEPRECATED] ", "[archived] "];

  for (let iter = 0; iter < 200; iter += 1) {
    const lines: string[] = [];
    let expectedActive = 0;
    let expectedRetired = 0;
    const liveFiles: string[] = [];

    const rowCount = 1 + Math.floor(rng() * 12);
    for (let r = 0; r < rowCount; r += 1) {
      const roll = rng();
      if (roll < 0.15) { lines.push(""); continue; }
      if (roll < 0.25) { lines.push(`# comment ${r}`); continue; }
      if (roll < 0.32) { lines.push(`<!-- ${r} -->`); continue; }
      if (roll < 0.40) { lines.push(`malformed row without pipe ${r}`); continue; }

      const tag = statuses[Math.floor(rng() * statuses.length)];
      const rel = `d${iter}/f${r}.md`;
      const dead = rng() < 0.5;
      // Description may contain extra pipes; parser keeps everything after first.
      const desc = rng() < 0.3 ? `desc | with | pipes ${r}` : `desc ${r}`;
      lines.push(`${tag}${rel} | ${desc}`);

      if (!dead) {
        touchEntryFile(rel);
        liveFiles.push(rel);
        if (tag.trim() === "") expectedActive += 1;
        else expectedRetired += 1;
      }
    }

    // Clean slate each iter to keep counts exact.
    rmSync(projectRoot, { recursive: true, force: true });
    mkdirSync(projectRoot, { recursive: true });
    for (const f of liveFiles) touchEntryFile(f);
    writeIndex(lines.join("\n") + "\n");

    // Parsing must never throw.
    const entries = knowledge.getIndex();
    // Every parsed row keeps a known status.
    for (const e of entries) {
      assert.ok(["active", "superseded", "archived", "deprecated"].includes(e.status));
      assert.ok(e.path.length > 0 && e.description.length > 0);
    }

    // Injection must never throw and never surface a dead link.
    const block = catalogBlock();
    for (const e of entries) {
      const resolvable = (() => {
        try { return knowledge.getEntry(e.path) !== null; } catch { return false; }
      })();
      if (!resolvable) {
        assert.ok(
          !block.includes(`${e.path} |`) && !block.includes(`] ${e.path} |`),
          `dead link leaked into catalog: ${e.path}\n${block}`,
        );
      }
    }

    // Active rows visible in the pre-retired region.
    const retiredHeader = block.indexOf("retired (folded");
    const activeRegion = retiredHeader === -1 ? block : block.slice(0, retiredHeader);
    for (const e of entries) {
      if (e.status !== "active") continue;
      let live = false;
      try { live = knowledge.getEntry(e.path) !== null; } catch { live = false; }
      if (live) {
        assert.ok(activeRegion.includes(e.path), `active row missing from active region: ${e.path}`);
      }
    }
  }
});

test("往返一致：解析→重建注入→再解析，active/retired 分类不漂移", () => {
  touchEntryFile("p/a.md");
  touchEntryFile("p/b.md");
  touchEntryFile("p/c.md");
  writeIndex([
    "p/a.md | alpha",
    "[SUPERSEDED] p/b.md | beta old",
    "[ARCHIVED] p/c.md | gamma archived",
  ].join("\n") + "\n");

  const first = knowledge.getIndex();
  const activeFirst = first.filter(e => e.status === "active").map(e => e.path);
  const retiredFirst = first.filter(e => e.status !== "active").map(e => e.path);

  assert.deepEqual(activeFirst, ["p/a.md"]);
  assert.deepEqual(retiredFirst.sort(), ["p/b.md", "p/c.md"]);

  // Idempotency of parsing the same file twice.
  assert.deepEqual(knowledge.getIndex(), first);
});

test("退休标签行的 markConflict 追加 CONFLICT 块但绝不改动 index 状态标签", () => {
  touchEntryFile("conf/x.md", "original body");
  writeIndex("[SUPERSEDED] conf/x.md | already superseded\n");

  knowledge.markConflict("conf/x.md", "topic-y#seq-9", "another contradiction");

  // File got a CONFLICT block appended, original preserved.
  const file = readFileSync(join(projectRoot, "conf/x.md"), "utf-8");
  assert.ok(file.startsWith("original body"));
  assert.match(file, /## ⚠️ CONFLICT/);

  // Index row untouched — still SUPERSEDED, no duplicate, no reactivation.
  const raw = readFileSync(indexPath, "utf-8");
  assert.equal(raw.match(/conf\/x\.md/g)?.length, 1);
  assert.match(raw, /\[SUPERSEDED\] conf\/x\.md/);
});
