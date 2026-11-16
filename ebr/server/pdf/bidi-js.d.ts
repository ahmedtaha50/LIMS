// bidi-js ships no types: the part used by server/pdf/writer.ts.
declare module 'bidi-js' {
  interface EmbeddingLevels { levels: Uint8Array; paragraphs: { start: number; end: number; level: number }[] }
  interface Bidi { getEmbeddingLevels(text: string, direction?: 'ltr' | 'rtl'): EmbeddingLevels; getReorderedString(text: string, levels: EmbeddingLevels, start?: number, end?: number): string }
  export default function bidiFactory(): Bidi;
}
