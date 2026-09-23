// Pure host/folder ordering helpers for the sidebar — no React/Tauri imports so
// they can be unit-tested directly.
//
// Model: the hosts array order IS the display order. It is kept "normalized":
// hosts of the first folder, then the second folder, …, then ungrouped hosts.
// Folder order is the folders array order.

import type { HostFolder } from "../types";

export interface Orderable {
  id: string;
  folder_id?: string | null;
}

export interface HostGroup<T> {
  folder: HostFolder | null; // null = ungrouped
  hosts: T[];
}

/** Folder a host is effectively in; dangling ids (deleted folder) → ungrouped. */
export function effectiveFolderId(h: Orderable, folders: HostFolder[]): string | null {
  return h.folder_id && folders.some((f) => f.id === h.folder_id) ? h.folder_id : null;
}

/** Split hosts into display groups: each folder in order, then ungrouped. */
export function groupHosts<T extends Orderable>(hosts: T[], folders: HostFolder[]): HostGroup<T>[] {
  const groups: HostGroup<T>[] = folders.map((f) => ({
    folder: f,
    hosts: hosts.filter((h) => effectiveFolderId(h, folders) === f.id),
  }));
  groups.push({ folder: null, hosts: hosts.filter((h) => effectiveFolderId(h, folders) === null) });
  return groups;
}

/** Re-order hosts into canonical display order (stable within each group). */
export function normalizeOrder<T extends Orderable>(hosts: T[], folders: HostFolder[]): T[] {
  return groupHosts(hosts, folders).flatMap((g) => g.hosts);
}

/**
 * Move a host into `folderId` (null = ungrouped), placed immediately before
 * `beforeId`, or at the end of that group when `beforeId` is null.
 * Returns the original array when nothing changes.
 */
export function moveHost<T extends Orderable>(
  hosts: T[],
  folders: HostFolder[],
  hostId: string,
  folderId: string | null,
  beforeId: string | null,
): T[] {
  const moving = hosts.find((h) => h.id === hostId);
  if (!moving || beforeId === hostId) return hosts;
  const targetFolder = folderId && folders.some((f) => f.id === folderId) ? folderId : null;

  const rest = hosts.filter((h) => h.id !== hostId);
  const moved = { ...moving, folder_id: targetFolder } as T;

  let idx = beforeId ? rest.findIndex((h) => h.id === beforeId) : -1;
  if (idx === -1) {
    // Append after the last host currently in the target group
    idx = rest.length;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (effectiveFolderId(rest[i], folders) === targetFolder) { idx = i + 1; break; }
    }
  }
  rest.splice(idx, 0, moved);
  const next = normalizeOrder(rest, folders);

  const unchanged =
    next.length === hosts.length &&
    next.every((h, i) => h.id === hosts[i].id) &&
    effectiveFolderId(moving, folders) === targetFolder;
  return unchanged ? hosts : next;
}

/** Move a folder before `beforeId`, or to the end when `beforeId` is null. */
export function moveFolder(folders: HostFolder[], folderId: string, beforeId: string | null): HostFolder[] {
  const moving = folders.find((f) => f.id === folderId);
  if (!moving || beforeId === folderId) return folders;
  const rest = folders.filter((f) => f.id !== folderId);
  let idx = beforeId ? rest.findIndex((f) => f.id === beforeId) : rest.length;
  if (idx === -1) idx = rest.length;
  rest.splice(idx, 0, moving);
  return rest.every((f, i) => f.id === folders[i].id) ? folders : rest;
}

/** Delete a folder; its hosts become ungrouped, keeping their relative order. */
export function deleteFolder<T extends Orderable>(
  hosts: T[],
  folders: HostFolder[],
  folderId: string,
): { hosts: T[]; folders: HostFolder[] } {
  const nextFolders = folders.filter((f) => f.id !== folderId);
  const nextHosts = hosts.map((h) => (h.folder_id === folderId ? ({ ...h, folder_id: null } as T) : h));
  return { hosts: normalizeOrder(nextHosts, nextFolders), folders: nextFolders };
}
