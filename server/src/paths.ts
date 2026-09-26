import { fileURLToPath } from "node:url";

/** Built client served to browsers. */
export const CLIENT_DIR = fileURLToPath(new URL("../../client/dist", import.meta.url));
