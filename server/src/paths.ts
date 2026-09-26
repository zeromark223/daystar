import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Built client served to browsers. */
export const CLIENT_DIR = fromHere("../../client/dist");

// The editable source lives in client/public; production images only ship client/dist.
const COLLISION_SOURCE = fromHere("../../client/public/assets/collision.txt");
export const COLLISION_FILE = existsSync(COLLISION_SOURCE)
  ? COLLISION_SOURCE
  : fromHere("../../client/dist/assets/collision.txt");
