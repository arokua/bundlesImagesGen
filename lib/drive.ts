import { Readable } from "node:stream";
import { google, drive_v3 } from "googleapis";
import type { DriveAuth } from "./driveAuth";

function escapeDriveQueryString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function getDriveClient(auth: DriveAuth) {
  return google.drive({ version: "v3", auth });
}

export type ChildFolder = { id: string; name: string };

/** All immediate subfolders of parent (paginated). */
export async function listChildFolders(
  drive: drive_v3.Drive,
  parentId: string,
): Promise<ChildFolder[]> {
  const out: ChildFolder[] = [];
  let pageToken: string | undefined;
  const parentQ = `'${escapeDriveQueryString(parentId)}' in parents`;
  do {
    const res = await drive.files.list({
      q: `${parentQ} and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "nextPageToken, files(id, name)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) out.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Folder matches SKU when the first whitespace-separated segment equals `sku`
 * (so `123 name` matches SKU `123`, but `1234 name` does not).
 * For all-numeric SKUs, a second segment that is all digits is rejected
 * (so `123 023 name` does not match SKU `123`).
 */
export function folderNameMatchesSku(folderDisplayName: string, sku: string): boolean {
  const trimmed = folderDisplayName.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/u);
  if (tokens[0] !== sku) return false;
  const skuIsDigits = /^\d+$/u.test(sku);
  if (
    skuIsDigits &&
    tokens.length >= 2 &&
    /^\d+$/u.test(tokens[1])
  ) {
    return false;
  }
  return true;
}

function matchFoldersForSku(children: ChildFolder[], sku: string): ChildFolder[] {
  return children.filter((c) => folderNameMatchesSku(c.name, sku));
}

/** Pick the single child folder whose name matches SKU rules; fails on 0 or 2+ matches. */
export function findFolderForSku(
  children: ChildFolder[],
  sku: string,
): drive_v3.Schema$File {
  const matches = matchFoldersForSku(children, sku);
  if (matches.length === 0) {
    throw new Error(
      `No folder under parent whose name starts with SKU "${sku}" (first token must equal the SKU; numeric SKUs cannot be followed by another digit-only token).`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple folders match SKU "${sku}": ${matches.map((m) => `"${m.name}"`).join(", ")}. Rename or merge in Drive.`,
    );
  }
  return { id: matches[0].id, name: matches[0].name };
}

/** Same matching rules as {@link findFolderForSku}, but returns null when nothing matches. */
export function findFolderForSkuOptional(
  children: ChildFolder[],
  sku: string,
): ChildFolder | null {
  const matches = matchFoldersForSku(children, sku);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Multiple folders match SKU "${sku}": ${matches.map((m) => `"${m.name}"`).join(", ")}. Rename or merge in Drive.`,
    );
  }
  return matches[0];
}

/** All child folders whose names match `sku` (same rules as {@link findFolderForSku}). */
export function findAllFoldersForSku(
  children: ChildFolder[],
  sku: string,
): ChildFolder[] {
  return matchFoldersForSku(children, sku);
}

/**
 * Resolve SKU folders under the primary parent’s children first; if none, under backup.
 * May return **multiple** folders when several names match (e.g. duplicate product lines).
 */
export function resolveAllFoldersForSku(
  primaryChildren: ChildFolder[],
  backupChildren: ChildFolder[] | null,
  sku: string,
): ChildFolder[] {
  const primary = findAllFoldersForSku(primaryChildren, sku);
  if (primary.length > 0) return primary;
  if (backupChildren) {
    const backup = findAllFoldersForSku(backupChildren, sku);
    if (backup.length > 0) return backup;
  }
  throw new Error(
    `No folder under primary (or backup) parent whose name starts with SKU "${sku}" (first token must equal the SKU; numeric SKUs cannot be followed by another digit-only token).`,
  );
}

/**
 * Resolve a SKU folder under the primary parent’s children first, then under backup children.
 * @deprecated Prefer {@link resolveAllFoldersForSku} when multiple folders may match.
 */
export function resolveFolderForSku(
  primaryChildren: ChildFolder[],
  backupChildren: ChildFolder[] | null,
  sku: string,
): ChildFolder {
  const primary = findFolderForSkuOptional(primaryChildren, sku);
  if (primary) return primary;
  if (backupChildren) {
    const backup = findFolderForSkuOptional(backupChildren, sku);
    if (backup) return backup;
  }
  throw new Error(
    `No folder under primary (or backup) parent whose name starts with SKU "${sku}" (first token must equal the SKU; numeric SKUs cannot be followed by another digit-only token).`,
  );
}

const IMAGE_MIME_PREFIX = "image/";

/**
 * Subset of Drive `image/*` types accepted as Gemini inline reference parts.
 * Photoshop PSD is `image/x-photoshop` on Drive but Gemini returns INVALID_ARGUMENT for it.
 */
function isGeminiInlineReferenceMime(mime?: string | null): boolean {
  if (!mime || !mime.startsWith(IMAGE_MIME_PREFIX)) return false;
  const m = mime.toLowerCase();
  if (m === "image/x-photoshop" || m === "image/vnd.adobe.photoshop") return false;
  return true;
}

export async function listImageFilesInFolder(
  drive: drive_v3.Drive,
  folderId: string,
): Promise<drive_v3.Schema$File[]> {
  const q = `'${escapeDriveQueryString(folderId)}' in parents and trashed = false`;
  const out: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q,
      fields: "nextPageToken, files(id, name, mimeType, size)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (isGeminiInlineReferenceMime(f.mimeType)) out.push(f);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return out;
}

export async function downloadFileBuffer(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<Buffer> {
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" },
  );
  const stream = res.data as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function createSubfolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
): Promise<string> {
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = created.data.id;
  if (!id) throw new Error("Drive did not return folder id.");
  return id;
}

export async function uploadBufferAsFile(
  drive: drive_v3.Drive,
  name: string,
  buffer: Buffer,
  mimeType: string,
  parentId: string,
): Promise<string> {
  const created = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = created.data.id;
  if (!id) throw new Error("Drive did not return file id.");
  return id;
}

/**
 * Copy an existing Drive file into a folder (same as “Make a copy” into a destination).
 * Use for reference originals alongside generated uploads.
 */
export async function copyDriveFileToFolder(
  drive: drive_v3.Drive,
  sourceFileId: string,
  newName: string,
  parentFolderId: string,
): Promise<string> {
  const res = await drive.files.copy({
    fileId: sourceFileId,
    requestBody: {
      name: newName,
      parents: [parentFolderId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = res.data.id;
  if (!id) throw new Error("Drive copy did not return file id.");
  return id;
}

/** Any immediate child (file or folder); used to detect empty bundle output folders. */
export async function countImmediateChildren(
  drive: drive_v3.Drive,
  folderId: string,
): Promise<number> {
  let n = 0;
  let pageToken: string | undefined;
  const q = `'${escapeDriveQueryString(folderId)}' in parents and trashed = false`;
  do {
    const res = await drive.files.list({
      q,
      fields: "nextPageToken, files(id)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    n += res.data.files?.length ?? 0;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return n;
}

async function getFolderSortTime(
  drive: drive_v3.Drive,
  folderId: string,
): Promise<number> {
  const res = await drive.files.get({
    fileId: folderId,
    fields: "modifiedTime,createdTime",
    supportsAllDrives: true,
  });
  const t = res.data.modifiedTime ?? res.data.createdTime;
  if (!t) return 0;
  return new Date(t).getTime();
}

export async function trashDriveFile(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<void> {
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
}

export type DedupeOutputFoldersResult = {
  /** Folder ids moved to trash. */
  trashedFolderIds: string[];
};

/**
 * Under the output parent, Google Drive allows multiple folders with the same display name.
 * For each duplicate name: remove empty copies first; if several remain with content, keep the
 * most recently modified and trash the rest. If all copies are empty, keep the latest empty only.
 */
export async function dedupeDuplicateOutputFolders(
  drive: drive_v3.Drive,
  outputParentId: string,
): Promise<DedupeOutputFoldersResult> {
  const folders = await listChildFolders(drive, outputParentId);
  const byName = new Map<string, ChildFolder[]>();
  for (const f of folders) {
    const arr = byName.get(f.name) ?? [];
    arr.push(f);
    byName.set(f.name, arr);
  }

  const trashedFolderIds: string[] = [];

  for (const [, group] of byName) {
    if (group.length <= 1) continue;

    const withMeta = await Promise.all(
      group.map(async (folder) => {
        const childCount = await countImmediateChildren(drive, folder.id);
        const sortTime = await getFolderSortTime(drive, folder.id);
        return { folder, isEmpty: childCount === 0, sortTime };
      }),
    );

    const nonEmpty = withMeta.filter((x) => !x.isEmpty);
    const empty = withMeta.filter((x) => x.isEmpty);

    const moveToTrash = async (id: string) => {
      await trashDriveFile(drive, id);
      trashedFolderIds.push(id);
    };

    if (nonEmpty.length >= 1) {
      for (const e of empty) {
        await moveToTrash(e.folder.id);
      }
      if (nonEmpty.length > 1) {
        nonEmpty.sort((a, b) => b.sortTime - a.sortTime);
        for (let i = 1; i < nonEmpty.length; i++) {
          await moveToTrash(nonEmpty[i].folder.id);
        }
      }
      continue;
    }

    // Only empty duplicates left: keep latest, trash older
    if (empty.length > 1) {
      empty.sort((a, b) => b.sortTime - a.sortTime);
      for (let i = 1; i < empty.length; i++) {
        await moveToTrash(empty[i].folder.id);
      }
    }
  }

  return { trashedFolderIds };
}
