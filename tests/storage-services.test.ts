import { describe, expect, it } from "vitest";

const baseURL = process.env.GOCHAT_RUNTIME_URL ?? "http://localhost:3000";
describe("configured S3 storage", () => {
  it.skipIf(process.env.GOCHAT_STORAGE_INTEGRATION !== "1")("reports the configured object-storage connection", async () => {
    const response = await fetch(`${baseURL}/api/v1/storage/health`);
    const body = await response.json() as { storage?: boolean; bucket?: string };
    expect(response.status).toBe(200);
    expect(body.storage).toBe(true);
    expect(body.bucket).toBeTruthy();
  }, 15_000);
});
