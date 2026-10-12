import { z } from 'zod';
export const healthSchema = z.object({ service: z.literal('resolve-api'), version: z.literal('1'), status: z.literal('ok') });
export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string().uuid() }) });
export type Health = z.infer<typeof healthSchema>;
