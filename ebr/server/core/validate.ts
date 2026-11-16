import { z } from 'zod';

/**
 * Input schemas are strict: an unknown field is an error, not something silently dropped. Use this for every body.
 * Server-controlled fields (id, timestamps, actor, status, version of a new record) are simply not in the schema, so a
 * client that sends them is refused.
 */
export const strict = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);

/** The version the client read, for optimistic concurrency on every update. */
export const version = z.number().int().min(1);
