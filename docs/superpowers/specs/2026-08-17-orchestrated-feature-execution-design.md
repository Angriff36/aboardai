# Orchestrated Feature Execution Design

## Goal

Add an optional execution mode that automatically coordinates three independently assigned AI roles for a feature: a high-end lead orchestrator, a capable lower-cost workhorse, and a high-end reviewer from a different provider. A feature may reach `verified` only after the reviewer explicitly approves the tested implementation.

Existing single-model execution remains available and unchanged.

## Execution Contract

When orchestration is enabled, AboardAI performs this server-enforced workflow:

1. Verify access to all three role assignments immediately before execution.
2. Ask the lead orchestrator to analyze the feature and produce a bounded implementation brief.
3. Give the workhorse the feature requirements and the lead's brief, then let it implement in the feature worktree.
4. Run the existing test and verification pipeline.
5. Give the reviewer the feature requirements, lead brief, implementation diff, and test evidence in read-only mode.
6. Parse a structured `APPROVE` or `REQUEST_CHANGES` verdict.
7. On `REQUEST_CHANGES`, return the findings to the lead orchestrator. The lead diagnoses the rejection and writes revised implementation instructions.
8. Give those instructions to the workhorse, rerun tests, and submit the result to the same reviewer.
9. Repeat for at most five review rounds.
10. Move the feature to `verified` only on explicit reviewer approval. If five rounds are exhausted, a role becomes unavailable, or the review response cannot be validated, preserve the work and move the feature to `waiting_approval` with a clear reason.

The lead cannot override the reviewer, and the workhorse cannot review its own work.

## Role Selection

Automatic selection uses the live enabled model catalog and successful access probes rather than a static version list.

- **Lead orchestrator:** strongest verified model available through Claude Code, Codex, or Cursor/Grok.
- **Workhorse:** verified implementation-capable model from a lower cost/performance tier. Prefer a provider distinct from the lead when available, but allow the same provider if needed.
- **Reviewer:** strongest verified high-end model whose execution provider differs from the lead's provider. Cross-provider separation is mandatory.

Family-aware ranking compares discovered model families, numeric versions, effort tiers, provider defaults, and capability metadata. It recognizes families such as Opus/Fable, Codex Sol, and Grok without enumerating exact model-version IDs, so newly discovered versions can win automatically.

Automatic execution refuses to start if it cannot verify a cross-provider reviewer. It never silently substitutes the lead or a same-provider model.

## Manual Overrides

Every role supports a manual model assignment from the existing provider-grouped catalog. Manual assignments preserve provider profile, thinking level, and reasoning effort.

Before an orchestration configuration is saved or bulk-applied, all manually selected roles are verified. The server verifies them again immediately before execution because authentication and subscription access may have changed.

Invalid combinations are blocked:

- Lead and reviewer use the same provider.
- Any role is unverified.
- Reviewer is not classified as review-capable/high-end.
- Lead and reviewer resolve to the same assignment.

## Persistence

`Feature` gains an optional orchestration configuration containing:

- Whether orchestration is enabled.
- Automatic or manual role selection.
- Optional assignments for lead, workhorse, and reviewer.
- Maximum review rounds, fixed to a safe range and defaulting to five.

The feature directory stores orchestration run artifacts separately from `feature.json`:

```text
.aboardai/features/{featureId}/orchestration/
  run.json
  lead-brief.md
  round-1-review.md
  round-1-revision.md
  ...
  round-5-review.md
```

`run.json` records resolved assignments, verification results, timestamps, current phase, round count, final verdict, and any terminal reason. Markdown artifacts make the reasoning and sign-off visible without bloating the feature record.

## UI

The Add Feature and Edit Feature dialogs gain an `Execution mode` control inside `AI & Execution`:

- **Single model** preserves the existing model selector.
- **Orchestrated** shows Lead, Workhorse, and Reviewer role cards.

Automatic orchestration is the default configuration within Orchestrated mode. Each role shows the currently proposed provider/model and offers a manual override. Provider groups remain collapsible and disabled providers stay hidden.

Mass Edit can enable or disable orchestration for selected features. The existing Balance Models dialog gains an orchestration distribution mode so selected or all backlog features can receive verified automatic configurations in one operation.

Single-model mode remains the application default until the user explicitly enables orchestration or sets it as a project default.

## Failure Semantics

- Lead fails before implementation: return the feature to `waiting_approval` with the lead error.
- Workhorse fails: use existing execution failure behavior and preserve diagnostics.
- Tests fail: the failure evidence is included in review; the reviewer may request changes.
- Reviewer unavailable or malformed verdict: `waiting_approval`, never `verified`.
- Five rejected rounds: `waiting_approval` with the full review/revision history.
- Cancellation: preserve artifacts and use existing cancellation recovery behavior.

## Testing

- Pure role ranking and provider-diversity tests.
- Configuration validation and serialization tests.
- State-machine tests proving the exact lead/workhorse/test/reviewer order.
- Rejection tests proving feedback returns to the lead before the workhorse.
- Five-round cap and `waiting_approval` fallback tests.
- Explicit approval as the only route to `verified`.
- Access re-verification before execution.
- Add/Edit/Mass Edit component tests for optional mode and manual overrides.
- Bulk assignment tests using the existing model catalog and grouped-provider visibility.
- Existing single-model execution regression tests.

## Success Criteria

- Users can keep assigning one model exactly as before.
- Orchestrated features automatically use verified lead, workhorse, and independent reviewer roles.
- Review rejection always returns to the lead, which revises the delegation before the workhorse edits again.
- No orchestrated feature reaches `verified` without a persisted cross-provider `APPROVE` verdict.
- The loop stops after at most five review rounds and preserves unfinished work for human review.
- New discovered model versions can be selected without updating a static model registry.
