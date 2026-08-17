import { getServerEnv } from "@asi/config";
import { closeDatabase, getOperationsSnapshot } from "@asi/database";

const env = getServerEnv();
const snapshot = await getOperationsSnapshot(env.STORAGE_PATH);
const payload = {
  drainable: snapshot.drainable,
  queue: snapshot.queue,
  storage: {
    documentCount: snapshot.storage.documentCount,
    fileCount: snapshot.storage.fileCount,
    findingCount: snapshot.storage.findings.length,
    findings: snapshot.storage.findings.slice(0, 50),
  },
};
process.stdout.write(`${JSON.stringify(payload)}\n`);
await closeDatabase();
