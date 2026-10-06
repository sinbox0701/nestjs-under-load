import { z } from 'zod';

export const orderCreateSchema = z
  .object({
    productId: z.number().int().positive(),
    qty: z.number().int().positive().max(1000),
  })
  .strict();

export type OrderCreateDto = z.infer<typeof orderCreateSchema>;

export const requestIdSchema = z.uuid();
