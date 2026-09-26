/**
 * Cluster settings of a game server, from the environment (docs/cluster.md
 * "Configuration"). CLUSTER_SECRET switches cluster mode on; without it the
 * server runs standalone exactly as before.
 */
export interface ServerClusterConfig {
  secret: string;
  server: number;
  publicUrl: string;
  meshUrl: string;
  capacity: number;
  agentUrl: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Cluster mode needs ${name}`);
  return value;
}

export function readServerClusterConfig(): ServerClusterConfig | null {
  const secret = process.env.CLUSTER_SECRET;
  if (!secret) return null;
  const server = Number(required("SERVER_ID"));
  const capacity = Number(required("SERVER_CAPACITY"));
  if (!Number.isInteger(server) || server < 1 || server > 255) throw new Error("SERVER_ID must be 1..255");
  if (!(capacity > 0)) throw new Error("SERVER_CAPACITY must be a positive number");
  return {
    secret,
    server,
    publicUrl: required("SERVER_PUBLIC_URL"),
    meshUrl: required("SERVER_MESH_URL"),
    capacity,
    agentUrl: required("AGENT_URL"),
  };
}
