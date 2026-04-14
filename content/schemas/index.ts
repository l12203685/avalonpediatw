/**
 * Content Collection Schemas for Avalonpedia master-Excel-derived YAML.
 *
 * Consumed by Astro Content Collections (when the Astro layer lands — see
 * `content/config.ts`). Until then these serve as the canonical shape
 * contract for anything that reads `content/_data/*.yaml`.
 *
 * Source of truth: `scripts/parse_master.py` emits one YAML file per Excel
 * sheet under `content/_data/`. Filenames follow `SPECIAL_SHEETS` aliasing
 * in the parser (e.g. `角色` -> `roles.yaml`, `規則` -> `rules.yaml`).
 *
 * Rationale for "loose" schemas: the master Excel is human-authored and
 * column structure drifts between seasons. We validate the stable
 * identifying fields and use `.passthrough()` to tolerate extra columns
 * without breaking the build. Tightening happens per-sheet as downstream
 * pages pin specific columns.
 */
import { z } from "astro/zod";

/** Record header emitted by the Python parser (comment lines start with #). */
export const parseMetaSchema = z.object({
  source: z.string(),
  generated_at: z.string(),
  sheets: z.array(
    z.object({
      sheet: z.string(),
      status: z.enum(["ok", "error"]),
      file: z.string().optional(),
      rows: z.number().int().nonnegative().optional(),
      skipped: z.number().int().nonnegative().optional(),
      header_cols: z.number().int().nonnegative().optional(),
      bytes: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
    }),
  ),
});

/** Roles sheet (角色 -> roles.yaml). */
export const rolesSchema = z
  .array(
    z
      .object({
        名稱: z.string().optional(),
        陣營: z.enum(["good", "evil"]).or(z.string()).optional(),
        能力: z.string().optional(),
      })
      .passthrough(),
  )
  .describe("Role definitions: 梅林/派西維爾/莫德雷德/etc.");

/** Rules sheet (積分賽規則 / S*-規則 -> rules.yaml). */
export const rulesSchema = z
  .array(z.record(z.string(), z.unknown()))
  .describe("Season rule text — loosely structured; free-form per season.");

/** Leaderboards: 生涯排序 / 戰績排序. */
export const leaderboardSchema = z
  .array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])))
  .describe("Leaderboard rows: player/metric pairs — column names vary.");

/** Career report: 生涯報表. */
export const careerReportSchema = z
  .array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])))
  .describe("Per-player career stats: win-rate/role-theory/etc.");

/** Synergy matrices: 同贏 / 同輸 / 贏T輸 / 贏相關 / 輸相關 / 同贏-同輸. */
export const synergyMatrixSchema = z
  .array(z.record(z.string(), z.union([z.number(), z.string(), z.null()])))
  .describe("Pairwise synergy — row keyed by player, columns = other players.");

/** Game records (牌譜) — the core log. */
export const gameRecordSchema = z
  .array(
    z
      .object({
        流水號: z.union([z.number(), z.string()]).optional(),
        文字記錄: z.string().optional(),
      })
      .passthrough(),
  )
  .describe("Per-game record rows with long-form text log.");

/** Team composition (陣容 -> team_composition.yaml). */
export const teamCompositionSchema = z
  .array(z.record(z.string(), z.unknown()))
  .describe("Team composition by player count.");

/** Map of known output filename (without extension) -> schema. */
export const schemaByFile = {
  roles: rolesSchema,
  rules: rulesSchema,
  team_composition: teamCompositionSchema,
  生涯報表: careerReportSchema,
  戰績報表: careerReportSchema,
  生涯排序: leaderboardSchema,
  戰績排序: leaderboardSchema,
  同贏: synergyMatrixSchema,
  同輸: synergyMatrixSchema,
  贏T輸: synergyMatrixSchema,
  贏相關: synergyMatrixSchema,
  輸相關: synergyMatrixSchema,
  "同贏-同輸": synergyMatrixSchema,
  牌譜: gameRecordSchema,
} as const;

export type SchemaKey = keyof typeof schemaByFile;
