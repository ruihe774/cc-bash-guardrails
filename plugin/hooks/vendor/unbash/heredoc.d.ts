import type { HereDocBody, WordPart } from "./internal-types.ts";
export declare class HereDocBodyImpl implements HereDocBody {
    #private;
    static _resolveParts: (source: string, body: HereDocBody, depth: number) => WordPart[] | undefined;
    type: "HereDocBody";
    pos: number;
    end: number;
    text: string;
    constructor(source: string, pos: number, quoted: boolean, depth: number);
    get parts(): WordPart[] | undefined;
    toJSON(): {
        type: "HereDocBody";
        pos: number;
        end: number;
        text: string;
        parts: WordPart[] | undefined;
    };
}
