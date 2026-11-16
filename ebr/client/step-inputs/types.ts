import type { ComponentType } from 'react';

/**
 * The input of one step type in the batch screen: its fields, and how to read them from the form. A track that adds a
 * step type on the server adds client/step-inputs/<type>.tsx here; the batch screen finds it by directory.
 */
export type StepInput = { type: string; Fields: ComponentType<{ def: Record<string, unknown> }>; read: (f: FormData) => Record<string, unknown> };
