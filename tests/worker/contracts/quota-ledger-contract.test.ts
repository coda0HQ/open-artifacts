import { env } from "cloudflare:workers";
import { D1QuotaLedger } from "../../../src/adapters/cloudflare/d1-quota-ledger";
import { MemoryQuotaLedger } from "../../../src/adapters/memory/quota-ledger";
import { ensureSchemaForTests } from "../../../src/store";
import { quotaLedgerContract } from "../../contracts/quota-ledger-contract";

quotaLedgerContract("memory", () => new MemoryQuotaLedger());
quotaLedgerContract("d1", async () => {
  await ensureSchemaForTests(env.DB);
  return new D1QuotaLedger(env.DB);
});
