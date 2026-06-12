# Lessons

## 2026-06-12 — "Leave me running" requires a pending wake-up source

**Mistake:** Ended the Phase 2 turn implying autonomous continuation ("or just leave me running"), but with zero pending background tasks nothing re-invokes the orchestrator — it idled all night.
**Rule:** When the user grants standing autonomy across phases, NEVER end a turn with the next phase unstarted. Either (a) keep working in the current turn, (b) leave a background agent running whose completion re-invokes me, or (c) explicitly schedule a wakeup (ScheduleWakeup) before ending the turn. State plainly what will happen if I stop.
