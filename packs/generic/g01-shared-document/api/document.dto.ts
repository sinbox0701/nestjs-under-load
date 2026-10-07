import { z } from 'zod';

export const requestIdSchema = z.uuid();

/** 버전은 number로만 strategy에 넘긴다. 숫자 문자열은 컨트롤러가 number로 바꾼다(`lockVersion`은 `!==` 엄격 비교). */
const versionSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]);

const tokenSchema = z.string().length(12);

const fieldValueSchema = z.array(z.string().max(64)).max(100_000);

export const fieldNameSchema = z.enum(['a', 'b', 'c', 'd']);

/** fence는 bigint 컬럼이라 응답에서 문자열로 나간다. 클라이언트가 숫자로 되돌려 보내도 받는다. */
const fenceSchema = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().transform(String)]);

export const putSchema = z
  .object({
    version: versionSchema,
    fields: z.object({ a: fieldValueSchema, b: fieldValueSchema, c: fieldValueSchema, d: fieldValueSchema }).strict(),
    editToken: tokenSchema,
    lease: z.object({ holder: z.string().min(1).max(128), fence: fenceSchema }).strict().optional(),
  })
  .strict();

export const patchSchema = z
  .object({
    version: versionSchema,
    field: fieldNameSchema,
    value: fieldValueSchema,
    editToken: tokenSchema,
  })
  .strict();

export const leaseAcquireSchema = z.object({ holder: z.string().min(1).max(128) }).strict();

export const leaseReleaseSchema = z.object({ holder: z.string().min(1).max(128), fence: fenceSchema }).strict();

export type PutDto = z.infer<typeof putSchema>;
export type PatchDto = z.infer<typeof patchSchema>;
