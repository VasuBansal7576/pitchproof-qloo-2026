# Performance verification

The quality-pass recording includes implementation, deployment, inspection and provider retries. Its duration is not a campaign latency measurement.

Research preserves every per-reference query. An advance runs at most three independent Qloo requests under one operation lease. Successful sibling queries persist when another query fails. Retry excludes completed steps. The synthesis and semantic review still run before directions become available.

The campaign list uses summaries from command responses. It reconciles with the server when opened or focused. Newer summary versions survive older list responses. Reopening an active operation reads its saved progress every 1.5 seconds while leased, rather than waiting for the full lease deadline.

## Controlled comparison

Run from the repository root with Node 22.13 or newer and installed dependencies. Supply a separate frozen source tree containing the baseline `server/` and `lib/` directories.

```sh
node --import tsx scripts/benchmark-research.mts --baseline /absolute/path/to/baseline --output /absolute/path/to/benchmark.json
```

The benchmark exercises the service commands and real local D1. Qloo responses are synthetic, with explicit waits of 250, 285 and 320 milliseconds. It runs five baseline/candidate pairs for initial research and five pairs for revision research. Each sample checks request counts, distinct query parameters, quota use, evidence counts, completed steps and reference/category provenance. It does not call external providers.

The measured region ends when research reaches synthesis. It excludes process startup, reference confirmation, browser and public-network round trips, model generation, semantic review and user inspection. The injected provider waits are the controlled limiter. These results cannot establish live provider speed or campaign quality.

| Research path | Baseline median and range | Candidate median and range | Work per sample |
| --- | --- | --- | --- |
| Initial | 2,948 ms, 2,891 to 3,076 ms | 1,114 ms, 1,069 to 1,117 ms | Nine queries, 54 records |
| Revision | 1,940 ms, 1,912 to 1,997 ms | 739 ms, 709 to 747 ms | Six queries, 36 records |

Each side has five successful samples per path and zero fixture failures. Initial research uses three advances instead of nine. Revision research uses two instead of six. Total Qloo request counts remain unchanged. Peak concurrency changes from one to three. The operation lease prevents overlapping advances for the same run; this is not a global limit across all visitors.

## Live verification

Measure the actual research-start request through reviewed-direction completion separately. Record failed attempts and quality rejections, not only successful requests. Keep generation and review in the measured path. A single paired live run is an observation, not a median, service-level promise or proof of future vendor availability. Quota exhaustion and rate limits remain disclosed failures with saved research. The app does not automatically retry a throttled provider.

Rerun behavior tests after changes to batching, leases, summary reconciliation or provider boundaries. Never trade canonical provenance, owner isolation, partial-failure recovery or semantic acceptance for a faster result.
