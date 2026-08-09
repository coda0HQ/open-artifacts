import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectRealtimeStore } from "../../../src/adapters/cloudflare/durable-object-realtime";
import { MemoryRealtimeSessionStore } from "../../../src/adapters/memory/realtime-session-store";
import { realtimeSessionStoreContract } from "../../contracts/realtime-session-store-contract";

realtimeSessionStoreContract("memory", async (test) => {
  await test(new MemoryRealtimeSessionStore());
});

realtimeSessionStoreContract("durable-object", async (test) => {
  const namespace = (env as unknown as { LIVE_DO: DurableObjectNamespace })
    .LIVE_DO;
  const stub = namespace.get(
    namespace.idFromName(`contract-${crypto.randomUUID()}`),
  );
  await runInDurableObject(stub, async (_instance, state) => {
    await test(new DurableObjectRealtimeStore(state.storage));
  });
});
