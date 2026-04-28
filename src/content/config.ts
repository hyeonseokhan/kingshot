import { defineCollection, z } from 'astro:content';

const guides = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    order: z.number().int().nonnegative(),
    category: z.enum(['beginner', 'events']),
  }),
});

export const collections = { guides };
