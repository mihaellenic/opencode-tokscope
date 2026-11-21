# Improvement proposal: historical per-model analytics

Status: Draft proposal — not an approved implementation design
Date: 2026-10-29
Investigation: 2026-10-27

## Intent

Expand Tokscope's per-model comparisons beyond throughput using only data
already retained in historical OpenCode sessions. Help users understand usage,
request size, timing, reliability, and recorded cost without collecting live
telemetry or consulting external pricing sources.

This document records the investigation and a recommended direction. The
priorities and approach below are proposals, not user-approved product decisions.

## Current behavior

Tokscope compares median throughput by provider/model, with daily trends and
project, time-range, and recorded-variant filters. Its durable samples retain
model/provider, variant, completion time, and throughput; unavailable samples
retain attribution and completion time.

- `src/metric.ts`: classifies assistant requests and computes throughput.
- `src/harvest.ts`: reads historical sessions and assistant messages, retaining
  only measured and unavailable samples.
- `src/stats.ts`: aggregates comparisons and daily median throughput.
- `src/history/records.ts`: defines and validates the durable cache.

Failed and incomplete requests are currently excluded. Most message fields are
discarded, so the existing cache cannot supply the proposed analytics by itself.

## Evidence and limits

The investigation inspected the installed OpenCode 2.1.2 schemas and read saved
session messages through the connected server's read-only API. It sampled 835
assistant requests across 30 sessions, excluding the investigation session:

| Field | Recent sample: 678 requests | Older July sample: 157 requests |
| --- | --- | --- |
| Token usage | 675 | 157 |
| Recorded cost | 675 | 157 |
| Stream-end timestamp | 676 | 0 |
| Completion timestamp | 678 | 157 |

In the recent sample, 650 requests reported positive cache-read tokens, 71 had
positive recorded cost, and 643 tool calls had created, ran, and completed
timestamps. Four requests had an `aborted` error. No request-level retry field
was observed; that field is schema-supported, not sample-validated.

Sampling was bounded to message pages from 20 recent and 10 oldest-updated
sessions, not a complete inventory or a representative benchmark. Counts describe
returned records before production deduplication and eligibility rules. Do not
extrapolate these coverage rates to all sessions or providers.

The key compatibility finding is that older history supports usage analytics even
when it cannot support the current throughput metric. Cost presence does not
establish accurate billing: most recent sampled cost values were zero.

## Candidate metrics

| Metric | Historical source / derivation | Interpretation |
| --- | --- | --- |
| Requests and usage share | Assistant-message counts by provider/model | Model requests, not prompts or completed tasks |
| Token totals | Input, output, reasoning, cache-read/write fields | Keep categories separate; unknown is not zero |
| Typical request size | Median/p95 input and generated tokens | Adds workload context to speed comparisons |
| Reasoning share | Reasoning / (output + reasoning) | Only for usable provider-reported usage and a positive denominator |
| Cache reuse | Cache-read / input-side token total | Token reuse, not a request-level cache-hit rate; verify input/cache accounting semantics |
| Recorded cost | Per-message USD cost | Recorded estimate, not verified billing |
| Response duration | `time.streamed - time.created` | Includes waiting before the response starts; excludes subsequent tool settlement |
| Full step duration | `time.completed - time.created` | Includes tool settlement; not pure model latency |
| Speed consistency | Throughput percentiles and spread | Derivable from current measured samples |
| Failures and cancellations | Structured errors and terminal state | Separate cancellation from provider/request failure |
| Finish reasons | Recorded finish reason | A normal stop is not proof of task success |
| Tool usage | Tool name, status, and timestamps in assistant content | Execution outcomes, not a model-quality score |
| Activity | Request timestamps and session membership | Requests/day, active days, first/last use, distinct sessions |
| Breakdowns | Recorded variant, agent, session/project | Attribute each request using its own message data |

Where meaningful, provide daily trends for these metrics using the existing
project, range, and variant filters. Cost-per-request may be derived from recorded
cost, but must not be described as actual billed cost.

## Constraints and non-goals

- Historical sessions are the sole source. No live instrumentation, external
  prices, provider quota APIs, or inferred subscription allocation.
- Preserve provider/model identity. Do not merge similarly named model IDs or
  silently combine providers.
- Do not assign a whole session's usage to its latest selected model: sessions
  can switch models and contain multiple agents.
- Do not reuse throughput eligibility as a gate for usage, cost, or reliability.
  Track field coverage independently for each metric.
- Distinguish missing, invalid, and recorded-zero values. A zero recorded cost
  does not establish free usage.
- Retain existing fork-duplication protection and define treatment of reverted,
  failed, cancelled, and unfinished requests before implementation.
- Keep metric populations explicit: a throughput sample count is not the total
  number of historical requests.
- Avoid persisting prompts, reasoning text, tool inputs, or tool outputs when
  numeric aggregates and attribution suffice.
- Preserve the current throughput definition unless separately approved.

Not reliably recoverable from the standard historical fields:

- Time to first token or pure decode speed.
- Actual bills, subscription allocation, or monetary cache savings.
- Model quality or task-success rate.
- Historical context-limit utilization percentage.

## Approaches considered

1. **Extend only the existing throughput aggregates.** Cheap and compatible with
   existing samples; enables speed percentiles but leaves most historical fields
   unused and excludes older non-measurable history.
2. **Extend historical ingestion and the durable cache. Recommended.** Retain
   minimal request facts or sufficient aggregates with per-metric eligibility.
   Supports the wider metric set and older history, but requires a versioned
   cache rebuild and careful attribution.
3. **Use the experimental session-statistics endpoint for usage summaries.** The
   installed schema exposes per-model steps, token usage, and recorded cost.
   Potentially reduces scanning, but its attribution, filtering, deduplication,
   missing-value behavior, and compatibility need verification. It cannot replace
   request-level timing distributions on its own.

No approach has been approved. The recommended approach builds on Tokscope's
existing history service rather than adding a separate telemetry system.

## Proposed delivery order

1. **Usage and coverage:** requests, token breakdown, typical request sizes, and
   explicit per-metric coverage.
2. **Timing and reliability:** response-duration percentiles, throughput spread,
   and separately labelled failures/cancellations.
3. **Recorded cost:** totals and per-request summaries, with missing/zero coverage
   and a clear non-billing label.
4. **Deeper detail:** cache reuse, tool usage, activity, agent/variant breakdowns.

This is prioritization guidance, not an implementation task plan. Exact page
layout, default columns, metric selectors, and sidebar changes remain open.

## Acceptance criteria for a future implementation

- Older requests without stream-end timing contribute to valid usage metrics but
  never appear as zero-throughput samples.
- Multi-model sessions attribute requests to their recorded provider/model and
  variant, not session-level current selection.
- Missing fields do not become zero; empty denominators produce unavailable
  metrics rather than misleading ratios.
- Cancellations, failed requests, tool failures, and unavailable speed samples
  remain distinct categories.
- Forked history does not double count inherited requests.
- Metric definitions state their eligible population and expose coverage.
- Cache upgrades rebuild from historical records without modifying source
  sessions; old snapshots cannot masquerade as complete new analytics.
- Tests cover attribution, missing fields, invalid timing, partial coverage,
  mixed outcomes, and cache-version handling.
- Any eventual TUI-visible change is verified in an isolated live OpenCode host
  using `scripts/dev-opencode.sh` and tmux, including persistence after relaunch.

## Decisions needed before implementation

- Which proposed metrics belong in the initial release and default comparison?
- Which outcome populations contribute to usage and recorded-cost totals?
- Should compaction usage be included? It is a separate historical message type,
  and model attribution is optional in the installed completed-compaction schema.
- What cache representation and rebuild policy balance detail with storage and
  scan cost?
- Can the experimental statistics endpoint satisfy the same accounting rules,
  or should the existing message scanner remain authoritative?

After these decisions and design approval, write an implementation plan. This
proposal does not authorize product changes or a release.
