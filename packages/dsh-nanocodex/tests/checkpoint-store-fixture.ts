import type { SessionId } from "@deepseek-ai/dsh-session";
import type {
  NanocodexCheckpoint,
  NanocodexCheckpointStore,
} from "../src/engine.js";

export function memoryCheckpoints(): NanocodexCheckpointStore {
  const records = new Map<SessionId, NanocodexCheckpoint>();
  return {
    get: (id) => records.get(id),
    put: async (id, checkpoint) => {
      records.set(id, checkpoint);
    },
  };
}
