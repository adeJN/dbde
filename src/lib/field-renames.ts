import type { Driver } from "../types";
export interface FieldRename {
  from: string;
  to: string;
}
export function fieldRenameError(
  names: string[],
  renames: FieldRename[],
  driver: Driver,
): string {
  const key = (name: string) =>
    driver === "postgres" ? name : name.toLowerCase();
  const targets = new Set<string>(),
    sources = new Set<string>();
  for (const rename of renames) {
    if (!rename.to.trim()) return "Field names cannot be empty.";
    if (rename.to.includes("\0"))
      return "Field names cannot contain NUL characters.";
    const limit = driver === "mysql" ? 64 : driver === "postgres" ? 63 : 255;
    const size =
      driver === "mysql"
        ? Array.from(rename.to).length
        : new TextEncoder().encode(rename.to).length;
    if (size > limit)
      return `Field names are limited to ${limit} ${driver === "mysql" ? "characters" : "bytes"}.`;
    if (driver === "mysql" && rename.to.endsWith(" "))
      return "MySQL field names cannot end with a space.";
    if (!names.includes(rename.from) || sources.has(rename.from))
      return "The table fields changed. Refresh the design before saving.";
    if (
      targets.has(key(rename.to)) ||
      names.some((name) => name !== rename.from && key(name) === key(rename.to))
    )
      return `Field name already exists: ${rename.to}. Save its rename separately first.`;
    sources.add(rename.from);
    targets.add(key(rename.to));
  }
  return renames.length > 256 ? "Rename up to 256 fields at a time." : "";
}
