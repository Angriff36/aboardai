# Live Model Catalog and Provider Groups Design

**Date:** 2026-08-17

## Problem

AboardAI can discover current models from provider CLIs and APIs, but some UI catalogs still filter those results through static or previously persisted model IDs. Cursor is the clearest failure: `agent models` returns current account models such as Composer 2.5 and Cursor Grok 4.6, while the picker can omit them because discovery synchronization currently occurs only from Cursor Settings.

The shared model list is also flat. A large configured provider such as OpenRouter can contribute hundreds of rows, obscuring providers the user actually wants. Existing provider enablement controls are not available where the model choice is made.

## Goals

- Use live provider discovery as the authoritative model inventory wherever the provider exposes one.
- Make new provider models appear without an AboardAI code change.
- Preserve explicit user model exclusions while enabling newly discovered models by default.
- Present models in collapsible provider groups instead of one flat list.
- Allow providers to be disabled and re-enabled globally from model-selection surfaces.
- Keep automatic balancing, manual balancing, and existing per-feature model selection compatible.

## Non-goals

- Invent a discovery API for providers that do not expose one.
- Change provider authentication, billing, or execution behavior.
- Automatically enable providers the user has disabled.
- Verify or spend credits on hidden providers.

## Live Catalog Architecture

The shared feature-model catalog becomes the single UI-facing aggregation layer. Each provider adapter returns:

- provider identity and display label;
- enabled/disabled state;
- discovery status and last successful refresh time;
- current model definitions;
- provider default model;
- explicit model exclusions;
- execution metadata needed by assignments.

For Cursor, Codex, Copilot, and OpenCode, live CLI discovery is authoritative. Custom API-compatible providers use their configured/discovered model inventory. Providers without authoritative discovery retain their maintained fallback catalog.

When a catalog-backed picker opens, it requests a refresh for enabled discoverable providers if their data is stale. Refreshes are deduplicated and bounded. The last successful inventory remains available if a provider is temporarily offline, with a visible stale/error indicator. Static models are fallback only when no successful live inventory exists.

## Model Preference Semantics

Discovered IDs must not be constrained by a TypeScript union or a static allowlist. Provider-qualified strings remain the persisted execution identity.

The preference model distinguishes:

- **explicitly excluded IDs**, which remain hidden after future refreshes;
- **newly discovered IDs**, which are enabled by default;
- **removed upstream IDs**, which disappear from new choices without corrupting existing saved features.

Existing enabled/known Cursor settings are migrated by treating previously known-but-not-enabled IDs as explicit exclusions. Current live IDs never seen before are automatically included. The same rule is used by other dynamic providers.

Catalog synchronization occurs inside the shared catalog/discovery layer, not inside a provider settings screen. Opening any picker therefore sees the same current inventory.

## Provider Visibility

Provider enablement is global and persistent:

- built-in providers use the existing `disabledProviders` setting;
- configured Claude-compatible providers, including OpenRouter profiles, use their existing `enabled` setting;
- dynamically connected OpenCode provider identities receive equivalent persisted visibility where required.

Disabling a provider removes its models from automatic balancing, manual model rows, verification requests, and shared feature-model choices. A compact provider header remains available in the grouped picker so the provider can be re-enabled without navigating elsewhere. Disabled providers do not trigger model discovery or access verification.

## Grouped Picker UX

All catalog-backed model selection is grouped by execution provider. Each group header contains:

- expand/collapse control;
- provider name;
- enabled model count;
- refresh/error state when relevant;
- global provider toggle.

Groups are collapsed by default except the currently selected provider or the first enabled provider. Expanding a group reveals only that provider's models. Search, when present, searches across enabled providers and temporarily exposes matching groups.

In **Automatic** balancing, the compact grouped view shows the preferred candidate chosen for each enabled provider. In **Manual** balancing, expanding a group exposes checkboxes for every enabled model. Turning a provider off immediately removes its candidates, invalidates verification, and rebalances the preview.

## Refresh and Failure Behavior

- Opening a picker refreshes stale enabled providers automatically.
- A manual refresh action remains available per provider.
- One provider's refresh failure does not block other groups.
- Cached successful results remain usable and are labeled stale when refresh fails.
- Access verification still runs against the exact provider/model candidates immediately before distribution.
- A provider disabled during setup is excluded before verification and assignment.

## Testing

Automated coverage will prove:

- live Cursor IDs such as `composer-2.5` and `cursor-grok-4.6-high-fast` appear without static constants;
- discovery synchronization occurs from a normal picker, without visiting Cursor Settings;
- new live IDs default to enabled while explicit exclusions remain excluded;
- dynamic results supersede static fallback results;
- provider groups expand and collapse accessibly;
- disabling OpenRouter persists and removes its models from all catalog consumers;
- disabled providers are not refreshed or verified;
- automatic and manual distribution still produce stable assignments;
- refresh failures retain labeled stale data and do not erase saved preferences.

Browser verification will use the real local Cursor discovery result and intercepted verification/update requests, consuming no provider credits and changing no real feature records.

## Acceptance Criteria

1. Composer 2.5 and available Cursor Grok 4.6 variants appear automatically from the installed Cursor CLI.
2. Future Cursor model additions require no AboardAI source change.
3. Models are separated into collapsible provider groups.
4. OpenRouter can be disabled from the grouped picker and remains disabled after restart.
5. Disabled providers contribute no automatic candidates and no verification calls.
6. Existing manual per-feature model choice remains available.
7. A failed provider refresh does not hide the last known usable inventory or block other providers.
