import { defineCollection, z } from 'astro:content';

const roles = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    faction: z.enum(['good', 'evil']),
    summary: z.string(),
    tags: z.array(z.string()).optional()
  })
});

export const collections = { roles };
