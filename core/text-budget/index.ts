import { createHash } from "node:crypto";

function assertPositiveByteCap(byteCap: number): void {
  if (!Number.isInteger(byteCap) || byteCap < 1) {
    throw new Error(`byteCap must be a positive integer, got ${byteCap}`);
  }
}

/**
 * Explicit, provenance-bearing excerpt (ADR-0030): nothing is silently dropped.
 * The marker carries the kept/total byte counts and the sha256 of the complete
 * text, so the original remains auditable in its source file.
 */
export function boundedExcerpt(text: string, byteCap: number): string {
  assertPositiveByteCap(byteCap);
  const totalBytes = Buffer.byteLength(text, "utf-8");
  if (totalBytes <= byteCap) return text;
  let keptBytes = 0;
  let end = 0;
  // Walk code points so the cut never splits a surrogate pair into U+FFFD.
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf-8");
    if (keptBytes + chBytes > byteCap) break;
    keptBytes += chBytes;
    end += ch.length;
  }
  const digest = createHash("sha256").update(text, "utf-8").digest("hex");
  return `${text.slice(0, end)}…[excerpt ${keptBytes}/${totalBytes} bytes sha256=${digest}]`;
}

/** Escape one text-node value without creating executable markup. */
export function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapedCharacter(ch: string): string {
  switch (ch) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    case "'": return "&apos;";
    default: return ch;
  }
}

/** Exact UTF-8 byte length after XML text-node escaping, without allocating it. */
export function escapedXmlByteLength(value: string): number {
  let bytes = 0;
  for (const ch of value) bytes += Buffer.byteLength(escapedCharacter(ch), "utf-8");
  return bytes;
}

/**
 * XML-safe counterpart to boundedExcerpt. `byteCap` applies after escaping,
 * which is the byte count that reaches a provider. The explicit marker keeps
 * the complete raw-byte digest and an operator/model retrieval route.
 */
export function boundedEscapedXmlText(text: string, byteCap: number, retrieval: string): string {
  assertPositiveByteCap(byteCap);
  if (escapedXmlByteLength(text) <= byteCap) return escapeXmlText(text);

  const totalBytes = Buffer.byteLength(text, "utf-8");
  const digest = createHash("sha256").update(text, "utf-8").digest("hex");
  const markerFor = (keptBytes: number) =>
    `…[excerpt ${keptBytes}/${totalBytes} bytes sha256=${digest}; retrieve via ${retrieval}]`;
  if (escapedXmlByteLength(markerFor(0)) > byteCap) {
    throw new Error(`byteCap ${byteCap} is too small for an explicit excerpt marker`);
  }

  const prefix: string[] = [];
  let keptRawBytes = 0;
  let keptEscapedBytes = 0;
  for (const ch of text) {
    const rawBytes = Buffer.byteLength(ch, "utf-8");
    const escapedBytes = Buffer.byteLength(escapedCharacter(ch), "utf-8");
    const nextRawBytes = keptRawBytes + rawBytes;
    if (keptEscapedBytes + escapedBytes + escapedXmlByteLength(markerFor(nextRawBytes)) > byteCap) break;
    prefix.push(ch);
    keptRawBytes = nextRawBytes;
    keptEscapedBytes += escapedBytes;
  }
  return escapeXmlText(`${prefix.join("")}${markerFor(keptRawBytes)}`);
}

/** Positive-integer env cap, consistent with the PI_BOARD_CATALOG_MAX_TOPICS parsing. */
export function boundedIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
