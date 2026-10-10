import { get, run } from "../db/index.js";

export function findById(id) {
  const row = get("SELECT id, folder_id, banned FROM guests WHERE id = ?", [
    id,
  ]);
  return row
    ? { id: row.id, folderId: row.folder_id, banned: Boolean(row.banned) }
    : null;
}
export function setBanned(id, banned) {
  run("UPDATE guests SET banned = ? WHERE id = ?", [banned ? 1 : 0, id]);
}
