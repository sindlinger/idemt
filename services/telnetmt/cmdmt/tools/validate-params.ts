import { dispatch } from "../src/lib/dispatch.js";
import { splitArgs } from "../src/lib/args.js";
import type { Ctx } from "../src/lib/args.js";

const ctx: Ctx = {
  symbol: "EURUSD",
  tf: "M5",
  sub: 1,
  baseTpl: "Default.tpl",
  profile: "dev"
};

const cases = [
  "indicador ZigZag --buffers 10 --log 50 --params depth=12 deviation=5 backstep=3",
  "indicator attach EURUSD H1 ZigZag sub=1 --params depth=12 deviation=5 backstep=3",
  "expert attach EURUSD H1 MyEA base.tpl --params lots=0.1"
];

let failed = 0;

for (const line of cases) {
  const tokens = splitArgs(line);
  const res = dispatch(tokens, { ...ctx });
  if (res.kind === "error") {
    failed += 1;
    process.stdout.write(`[ERR] ${line}\n  ${res.message}\n`);
    continue;
  }
  if (res.kind === "send") {
    process.stdout.write(
      `[OK] ${line}\n  send ${res.type} params=${JSON.stringify(res.params)} meta=${JSON.stringify(res.meta ?? {})}\n`
    );
    continue;
  }
  if (res.kind === "multi") {
    process.stdout.write(
      `[OK] ${line}\n  multi steps=${res.steps.map((s) => s.type).join(",")} meta=${JSON.stringify(res.meta ?? {})}\n`
    );
    continue;
  }
  if (res.kind === "test") {
    process.stdout.write(`[OK] ${line}\n  test spec=${JSON.stringify(res.spec)}\n`);
    continue;
  }
  process.stdout.write(`[OK] ${line}\n  ${res.kind}\n`);
}

if (failed) process.exitCode = 1;
