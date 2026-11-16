# 逐篇閱讀／書目核對矩陣

> 狀態定義：`indexed_only` = 僅有來源索引；`legacy_code_review` = 過往文獻報告宣稱已閱讀官方程式碼（**不是論文全文**）；`legacy_abstract_review` = 過往報告有摘要層內容；`full_text_read` = 本 Repo 有來源、頁碼、日期及全文完整閱讀紀錄。初始**沒有**擅自標記任何新的 `full_text_read`。

| ID | 研究／資料 | 現有可稽核狀態 | 需補的證據 | AI 負責 |
|---|---|---|---|---|
| P001 | CSP4SDG: Constraint and Information-Theory Based Role Identification in Social Deduction Games with LLM-Enhanced Inference | `indexed_only` | 核對 URL、作者、出版與授權；必要時取得全文 | 待指派 |
| P002 | Bayesian Social Deduction with Graph-Informed Language Models | `legacy_abstract_review` | 舊報告摘要層；需核對出版書目、全文方法及實驗表格 | 待指派 |
| P003 | AVCORP: Identifying and Resisting Deception via Communication Theory and Theory of Mind | `indexed_only` | 核對 URL、作者、出版與授權；必要時取得全文 | 待指派 |
| P004 | Hidden-Role Games: Equilibrium Concepts and Computation | `legacy_abstract_review` | 舊報告摘要層；需核對出版書目、全文方法及實驗表格 | 待指派 |
| P005 | Finding Friend and Foe in Multi-Agent Games | `legacy_code_review` | `r7_literature.md` 註記曾讀 DeepRole 原始碼；另需讀論文全文與 DOI | 待指派 |
| P006 | Long-Horizon Dialogue Understanding for Role Identification in the Game of Avalon with Large Language Models | `legacy_abstract_review` | 舊報告摘要層；需核對出版書目、全文方法及實驗表格 | 待指派 |
| P007 | Balancing Epistemic Value and Social Safety: PACR-Pro for False-Consensus Intervention in One Night Ultimate Werewolf | `indexed_only` | 核對 URL、作者、出版與授權；必要時取得全文 | 待指派 |
| P008 | Do LLMs Trust the Accuser or the Accusation? Measuring Belief Shifts in Werewolf | `indexed_only` | 核對 URL、作者、出版與授權；必要時取得全文 | 待指派 |
| P009 | MARBO: Relational Belief Grounding for LLM Agents in Social Deduction Games | `indexed_only` | 核對 URL、作者、出版與授權；必要時取得全文 | 待指派 |
| P010 | Auditing Belief-Conditioned LLM Agents in Hidden-Information Social Deduction Games | `indexed_only` | 核對 URL、作者、出版與授權；必要時取得全文 | 待指派 |
| P011 | MafiaScope: Non-Invasive, Time-Resolved Belief Probing for LLM Agents in Social Deduction Games | `indexed_only` | 核對 URL、作者、出版與授權；必要時取得全文 | 待指派 |
| D001 | AvalonLogs (public game logs) | `indexed_only` | 核對 URL、作者、出版與授權；必要時取得全文 | 待指派 |
| D002 | Bayesian-Avalon public code & replay data | `indexed_only` | 核對 URL、作者、出版與授權；必要時取得全文 | 待指派 |
| R001 | The Resistance: Avalon rulebook | `indexed_only` | 核對 URL、作者、出版與授權；必要時取得全文 | 待指派 |

## 驗收格式（完成一篇才更新一行）

```yaml
id: P001
reading_status: full_text_read # ONLY after actual full text
verified_title: ...
authors: ...
published_at: YYYY-MM-DD
fulltext_url: ...
read_at_taipei: YYYY-MM-DD
read_by: claude | chatgpt | human
pages_or_sections_checked: ["§1", "§2", "§3", "§4", "Appendix"]
method: ...
dataset_and_protocol: ...
results_with_table_or_page: ...
limits: ...
reproduction_status: not_started | tested | reproduced | contradicted
avalon_transfer_assumptions: ...
linked_wiki_ids: [wiki-147]
linked_code: [packages/server/src/ai/belief/Certainty.ts]
```

**禁止**用 GitHub PR 的 commit 存在就認定論文已閱讀，或用中文二手摘要補上不存在的正文頁碼。程式碼閱讀、摘要閱讀、論文全文、成果重現是四種不同證據。
