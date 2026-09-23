/**
 * Unit tests for src/utils/hostOrder.ts (sidebar drag-sort + folders).
 */
import { test, expect } from "@playwright/test";
import {
  groupHosts, normalizeOrder, moveHost, moveFolder, deleteFolder, effectiveFolderId,
} from "../src/utils/hostOrder";
import type { HostFolder } from "../src/types";

const F: HostFolder[] = [
  { id: "f1", name: "Prod", collapsed: false },
  { id: "f2", name: "Lab", collapsed: false },
];
type H = { id: string; folder_id?: string | null };
const ids = (hs: H[]) => hs.map((h) => h.id).join(",");

const base: H[] = [
  { id: "a", folder_id: "f1" },
  { id: "b", folder_id: "f1" },
  { id: "c", folder_id: "f2" },
  { id: "d" },
  { id: "e", folder_id: null },
];

test("groupHosts: folders in order, then ungrouped", () => {
  const g = groupHosts(base, F);
  expect(g.map((x) => x.folder?.id ?? "-")).toEqual(["f1", "f2", "-"]);
  expect(g.map((x) => ids(x.hosts))).toEqual(["a,b", "c", "d,e"]);
});

test("effectiveFolderId: dangling folder id is ungrouped", () => {
  expect(effectiveFolderId({ id: "x", folder_id: "gone" }, F)).toBeNull();
});

test("normalizeOrder: interleaved input becomes grouped, stable within groups", () => {
  const mixed: H[] = [{ id: "d" }, { id: "c", folder_id: "f2" }, { id: "a", folder_id: "f1" }, { id: "b", folder_id: "f1" }];
  expect(ids(normalizeOrder(mixed, F))).toBe("a,b,c,d");
});

test("moveHost: reorder within a folder", () => {
  expect(ids(moveHost(base, F, "b", "f1", "a"))).toBe("b,a,c,d,e");
});

test("moveHost: into another folder before a host", () => {
  const r = moveHost(base, F, "d", "f2", "c");
  expect(ids(r)).toBe("a,b,d,c,e");
  expect(r.find((h) => h.id === "d")?.folder_id).toBe("f2");
});

test("moveHost: append to folder end when beforeId is null", () => {
  expect(ids(moveHost(base, F, "e", "f1", null))).toBe("a,b,e,c,d");
});

test("moveHost: into an empty folder", () => {
  const folders = [...F, { id: "f3", name: "Empty", collapsed: false }];
  const r = moveHost(base, folders, "a", "f3", null);
  expect(ids(r)).toBe("b,c,a,d,e");
  expect(r.find((h) => h.id === "a")?.folder_id).toBe("f3");
});

test("moveHost: out of a folder to ungrouped end", () => {
  const r = moveHost(base, F, "a", null, null);
  expect(ids(r)).toBe("b,c,d,e,a");
  expect(r.find((h) => h.id === "a")?.folder_id).toBeNull();
});

test("moveHost: no-op returns same array reference", () => {
  expect(moveHost(base, F, "a", "f1", "b")).toBe(base);
  expect(moveHost(base, F, "a", "f1", "a")).toBe(base);
  expect(moveHost(base, F, "zzz", "f1", null)).toBe(base);
});

test("moveFolder: reorder and no-op", () => {
  expect(moveFolder(F, "f2", "f1").map((f) => f.id)).toEqual(["f2", "f1"]);
  expect(moveFolder(F, "f1", null).map((f) => f.id)).toEqual(["f2", "f1"]);
  expect(moveFolder(F, "f1", "f2")).toBe(F);
});

test("deleteFolder: hosts become ungrouped, folder removed", () => {
  const r = deleteFolder(base, F, "f1");
  expect(r.folders.map((f) => f.id)).toEqual(["f2"]);
  expect(ids(r.hosts)).toBe("c,a,b,d,e");
  expect(r.hosts.filter((h) => h.folder_id === "f1")).toHaveLength(0);
});
