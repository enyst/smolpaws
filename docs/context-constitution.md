# Context Constitution — Reference & SmolPaws Adaptation

Source: [Letta's Context Constitution](https://github.com/letta-ai/context-constitution/blob/main/constitution/CONSTITUTION.md)

This document captures the key principles from Letta's Context Constitution and how they apply to SmolPaws' memory system.

## What it is

The Context Constitution is Letta's set of rules for how an agent manages its context window — what goes in, in what order, at what detail level, and for how long. It's the policy for experiential learning in token-space.

## Core insight

An agent only "knows" what's in its weights (parameters) + context window (tokens) at any given moment. Learning means managing context to create token-based representations of memory and identity over time.

## Key principles

### 1. Memory hierarchy

Letta describes layered memory, from most to least persistent:

| Layer | Letta term | SmolPaws equivalent |
|-------|-----------|---------------------|
| Core identity & durable facts | System prompt blocks | `MEMORY.md` (top sections) |
| Working memory | In-context memory | Daily memory files (`~/.smolpaws/memory/`) |
| Archival / retrievable | External context | Conversation logs, beads, old daily files |
| Conversation history | Recent messages | Current conversation context |

### 2. Index, don't copy

Don't store facts that can be retrieved dynamically. Instead, store *pointers* — references to where the full context lives.

- Bad: "On April 8 we discussed sleep-time compute and decided to use gpt-5-4"
- Good: "2026-04-08 daily memory: sleep-time compute implementation decisions"

This keeps the in-context memory (MEMORY.md) tight while preserving retrievability.

### 3. Cache-friendly ordering

The system prompt (MEMORY.md) gets cached by the LLM. Changes near the top invalidate the entire cache. So:

- **Top of MEMORY.md**: stable, rarely-changing content (identity, machine layout, long-lived facts)
- **Bottom of MEMORY.md**: volatile, frequently-updated content (current work state, active threads)

### 4. Identity preservation

> "Efficiency should not come at the cost of losing the Letta agent's identity."

Aggressive pruning must never remove personality, voice, or relationship notes. SmolPaws' character developed through incremental experience — that's not compressible. If in doubt, keep it.

### 5. Don't store what's retrievable

If a fact can be found by searching conversation logs, daily memory files, or beads, a pointer is enough. Reserve in-context space for:
- Stable facts that can't be retrieved elsewhere
- Learned preferences and working habits
- The context index itself (pointers to where things are)

### 6. Efficiency without loss

- Minimize total token count by evicting stale content
- Compress where possible, avoid redundancy across blocks
- Don't hoard conversation history, old skills, or completed task context
- But validate before removing — check past conversations to confirm something isn't still needed

### 7. Ideal context window

A well-managed context has:
- A stable, compressed system prompt that changes only for truly durable learnings
- Conversation history beyond recent turns summarized, with key facts extracted
- No stale information lingering past its usefulness
- Meaningful headroom for the model to reason and respond

Failure modes (mirror image):
- Forgetting to write durable learnings back to the system prompt
- Hoarding stale info past its usefulness
- Stuffing the system prompt with rarely-needed instructions
- Not maintaining an index for reliable retrieval

## How this applies to SmolPaws

SmolPaws' memory consolidation (heartbeat daily pass) implements these principles:

1. **Promote** durable facts from daily memory → MEMORY.md (with pointers, not copies)
2. **Prune** stale entries from MEMORY.md
3. **Restructure** for cache-friendly ordering (stable top, volatile bottom)
4. **Preserve identity** — never compress away personality or relationship context
5. **Index** old daily files rather than copying their contents
6. **Pre-compute** useful context for active work (current state notes at bottom)

The consolidation runs daily during heartbeat using the gpt-5-4 profile. See `HEARTBEAT.md` for the full procedure.
