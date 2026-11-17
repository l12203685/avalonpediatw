# P001 CSP4SDG — metadata verification (not a full-text review)

- Checked by: ChatGPT, 2026-11-17 (Taipei)
- Evidence level: `metadata_only`. **No PDF/HTML full-text reading, page-by-page validation, experiment reproduction, or code execution has been completed.**
- Verified title: *CSP4SDG: Constraint and Information-Theory Based Role Identification in Social Deduction Games with LLM-Enhanced Inference*
- Verified authors: Kaijie Xu; Fandi Meng; Clark Verbrugge; Simon Lucas
- Original preprint: [arXiv:2511.06175](https://arxiv.org/abs/2511.06175), v1 submitted 2025-11-09 UTC; [arXiv DOI](https://doi.org/10.48550/arXiv.2511.06175)
- Official code: [Nortrom1213/CSP4SDG](https://github.com/Nortrom1213/CSP4SDG); README identifies AAAI 2026 and supplies a 2025 arXiv citation. This supports the author's stated venue, **not independent verification of the proceedings record**.
- [AAAI article landing page](https://ojs.aaai.org/index.php/AAAI/article/view/38453): attempted, blocked by automated-access protection. Do not infer proceedings DOI, page range, or publication date from this attempt.
- Data availability: repository README says the datasets are **not included** and lists external Avalon-NLU, Mafia-UCB, and AvalonLogs downloads. Dataset licenses, code license and reproducibility remain unverified.

## Evidence-bounded method notes

The **arXiv abstract** describes four classes of constraints (evidence, phenomena, assertions, hypotheses), hard pruning of impossible role assignments, weighted soft constraints and information-gain weighting. It **claims** evaluation on three public datasets and improvement over LLM baselines. This is an **author claim from the abstract**, not a checked experimental result; no numeric uplift is recorded.

## Applicability to AvalonPediaTW

**Potentially directly transferable as a testable method, not yet validated:** map publicly visible mission outcomes and legally observable lake declarations to hard constraints, and map proposal/vote behavior to calibrated soft likelihoods. Candidate integration points are `packages/server/src/ai/belief/Certainty.ts`, `BayesBelief.ts`, and `LogicGates.ts`. Do not treat statements or hidden identities as public evidence.

**Reference only:** dialogue-driven assertions, LLM prompting and language metrics. The current bot does not speak; R1/R2 ballots are constrained to normal votes, and the leader must join the proposed team (`docs/ai/wiki_sop_map.md` §0). General social-deduction datasets cannot directly establish a ten-player Avalon win-rate improvement.

**Falsifiable hypothesis for Claude's later engineering work:** On a fixed event-history fixture with a selected observer, a hard-constraint implementation must remove exactly the role assignments logically contradicted by mission results and observer-visible lake facts, without ever excluding the ground-truth assignment under the documented rules. Test each observer's view against the existing `Certainty.ts` hard-world set. For soft weights, use held-out human logs and report Brier/log loss/ECE before paired-seed final blue-win evaluation. **Entropy reduction alone is not success.**

## Open verification blockers

1. Obtain and read the complete paper, including experiments, tables, appendices, limitations, and exact definitions; record sections/pages and reading date.
2. Independently verify AAAI 2026 proceedings bibliographic metadata and publisher DOI.
3. Verify code and dataset licenses, exact repository commit and preprocessing provenance.
4. Determine whether source methods assume five-player rules, dialogue availability, or other incompatible information channels.

No formal AI changes or large-scale self-play are authorized by this note.
