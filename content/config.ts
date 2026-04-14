/**
 * Astro Content Collections config — staged for the future Astro site.
 *
 * The repo has no Astro package yet (`packages/web` is Vite+React). When
 * Astro lands, copy this file to `packages/<astro-app>/src/content/config.ts`
 * or import the schemas from `content/schemas`.
 *
 * The schemas live in `./schemas/index.ts` and are exported standalone so
 * they remain useful for runtime YAML validation (see
 * `scripts/validate_yaml.py` for the Python-side equivalent).
 */
import { defineCollection } from "astro:content";
import {
  rolesSchema,
  rulesSchema,
  leaderboardSchema,
  careerReportSchema,
  synergyMatrixSchema,
  gameRecordSchema,
  teamCompositionSchema,
} from "./schemas";

export const collections = {
  roles: defineCollection({ type: "data", schema: rolesSchema }),
  rules: defineCollection({ type: "data", schema: rulesSchema }),
  team_composition: defineCollection({
    type: "data",
    schema: teamCompositionSchema,
  }),
  career: defineCollection({ type: "data", schema: careerReportSchema }),
  leaderboard: defineCollection({ type: "data", schema: leaderboardSchema }),
  synergy: defineCollection({ type: "data", schema: synergyMatrixSchema }),
  games: defineCollection({ type: "data", schema: gameRecordSchema }),
};
