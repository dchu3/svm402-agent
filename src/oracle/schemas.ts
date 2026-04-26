import { z } from 'zod';

export const ReportResponseSchema = z
  .object({
    address: z.string(),
    chain: z.literal('base'),
    risk: z
      .object({
        score: z.number(),
        level: z.string(),
        flags: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough();

export type ReportResponse = z.infer<typeof ReportResponseSchema>;
