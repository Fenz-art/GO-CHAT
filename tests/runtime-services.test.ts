import { describe, expect, it } from "vitest";

const runtimeURL = process.env.GOCHAT_RUNTIME_URL ?? "http://localhost:3000";

describe("configured runtime services", () => {
  it("reports dependency health accurately without blocking on an unavailable Redis service", async () => {
    expect(process.env.GOCHAT_POSTGRES_URL).toMatch(/^postgres(ql)?:\/\//);
    expect(process.env.GOCHAT_REDIS_URL).toMatch(/^rediss?:\/\//);
    let response: Response | undefined;
    let body: { status: string; postgres: boolean; redis: boolean } | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetch(`${runtimeURL}/api/v1/health`, { signal: AbortSignal.timeout(2_500) });
      body = await response.json() as { status: string; postgres: boolean; redis: boolean };
      if (body.postgres || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (!response || !body) throw new Error("Health endpoint did not return a response");
    expect(body.postgres).toBe(true);
    if (body.redis) {
      expect(response.status).toBe(200);
      expect(body.status).toBe("ok");
    } else {
      expect(response.status).toBe(503);
      expect(body.status).toBe("degraded");
    }
  }, 12_000);
});
