export const DRIVE_BACKUP_PARENT_ENV_KEYS = [
  "PARENT_FOLDER_FALLBACK_ID",
  "PARENT_FOLDER_BACKUP_2_ID",
  "PARENT_FOLDER_BACKUP_3_ID",
] as const;

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const id = raw?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getConfiguredBackupParentIds(primaryParentId?: string | null): string[] {
  const primary = primaryParentId?.trim() || "";
  return uniqueNonEmpty(
    DRIVE_BACKUP_PARENT_ENV_KEYS.map((key) => process.env[key])
      .map((id) => id?.trim() || "")
      .filter((id) => id !== primary),
  );
}

export function resolveSearchParentIds(
  primaryParentId: string,
  requestedBackupParentIds?: unknown,
): string[] {
  const requested = Array.isArray(requestedBackupParentIds)
    ? requestedBackupParentIds.map((v) => String(v ?? "").trim())
    : [];
  return uniqueNonEmpty([primaryParentId, ...requested, ...getConfiguredBackupParentIds(primaryParentId)]);
}
