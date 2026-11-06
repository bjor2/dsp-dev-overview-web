// ADDENDA-011 §5 / V-008: only allowlisted refs become links. Everything else is rendered as plain text.
// No file://, vscode://, shell or javascript: links; hrefs never come from an unchecked payload string.
import type { ArchSourceKind } from "../api/types";

const ALLOW: { kind: ArchSourceKind; test: (ref: string) => boolean; href: (ref: string) => string }[] = [
  { kind: "confluence", test: (r) => /^https:\/\/dahl-it\.atlassian\.net\/wiki\/[A-Za-z0-9/_\-.~%+]*$/.test(r), href: (r) => r },
  // repo + registration refs are rendered as text (code) in the first slice; a later slice may map
  // "<repo-name>/<path>" to an https origin from a fixed table here, never from the payload.
];

/** `href` only when the ref passes the allowlist for its kind. */
export function renderRef(kind: ArchSourceKind, ref: string): { text: string; href?: string } {
  const rule = ALLOW.find((a) => a.kind === kind && a.test(ref));
  return rule ? { text: ref, href: rule.href(ref) } : { text: ref };
}
