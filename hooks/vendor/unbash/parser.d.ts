export type * from "./types.ts";
import type { ParsedScript } from "./internal-types.ts";
export declare function parse(source: string): import("./types.ts").ParsedScript;
export declare function parseRegion(source: string, start: number, end: number, depth?: number, parenBoundary?: boolean): ParsedScript;
