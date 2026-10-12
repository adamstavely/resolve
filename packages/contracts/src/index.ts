import { z } from 'zod';

export const healthSchema = z.object({ service: z.literal('resolve-api'), version: z.literal('1'), status: z.literal('ok') });
export type Health = z.infer<typeof healthSchema>;

export * from './common';
export * from './tenant-tools';
export * from './capabilities';
export * from './registry';
export * from './oauth';
export * from './jobs';
export * from './audit';
export * from './compatibility';
export * from './outcomes';
export * from './fleet';
export * from './broadcasts';
export * from './fleet-read';
export * from './operations';
export * from './session';
export * from './admin';
export * from './onboarding';
export * from './observability';
