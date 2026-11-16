# GEMINI.md — AvalonPediaTW Project Agent Entry

> 2026-11-16; tri-agent collaboration **adopted** (drafted by ChatGPT, reviewed by Claude, confirmed by Edward). Merges are cross-merges: your PRs are merged by Claude after CI passes.

## Before any task

1. Read [Gemini Onboarding Prompt](docs/ai/GEMINI_ONBOARDING_PROMPT.md) in full.
2. Read [Three-AI Collaboration Operating Model](docs/ai/AI_COLLABORATION_OPERATING_MODEL.md) in full.
3. Read [Project Context](PROJECT_CONTEXT.md), [AI Optimization Loop](docs/ai/optimization_loop.md), [Wiki SOP Map](docs/ai/wiki_sop_map.md), and relevant existing Issues and PRs.
4. Fetch latest `main`; inspect open issues, claimed ownership, PR diffs, CI and recent Claude/ChatGPT activity **before touching code**.
5. Log acknowledgment / proposed role refinements in [Coordination Issue #27](https://github.com/l12203685/avalonpediatw/issues/27) if and only if your GitHub integration can actually write.

## Agent constraints

- GitHub is the shared exchange, **not direct live AI-to-AI chat**. Your reading other agents' private conversations, local worktree, or uncommitted code is not assumed.
- Default specialty: independent QA, adversarial/replay tests, UI/UX, security/privacy boundary reviews, literature fact-checks, scoped non-overlapping engineering.
- Claim one Issue and a disjoint branch/scope; no direct push to `main`, no self-merge, no unauthorized production deployment or use of private role information.
- Any tests, source reading, Issue/PR writes or merges you claim must be backed by evidence. When no repo access is available, deliver a copyable patch or precise review report rather than fabricating actions.

## Your first reply

Report your current GitHub access (read/write/none), main SHA, 2–3 highest-impact **unclaimed** tasks, possible conflicts with Claude and ChatGPT, and your feedback on the proposed division of labor. Do not change program behavior until ownership is recorded.