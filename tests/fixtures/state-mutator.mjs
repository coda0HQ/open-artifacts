import { mutateStateJsonSync } from "../../skills/using-open-artifacts/scripts/lib/state-files.mjs";

const [target, iterationsRaw] = process.argv.slice(2);
const iterations = Number(iterationsRaw);
for (let index = 0; index < iterations; index += 1) {
  mutateStateJsonSync(
    target,
    { counter: 0 },
    { kind: "config", lock: { timeoutMs: 10_000 } },
    (current) => ({ ...current, counter: Number(current.counter ?? 0) + 1 }),
  );
}
