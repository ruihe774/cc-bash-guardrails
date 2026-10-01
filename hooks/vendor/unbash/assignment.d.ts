import type { ArrayValue, Assignment, Word } from "./internal-types.ts";
export declare class AssignmentImpl implements Assignment {
    #private;
    type: "Assignment";
    pos: number;
    end: number;
    text: string;
    constructor(text: string, pos: number, end: number, source: string, operatorPos: number, depth: number);
    get name(): string;
    get append(): boolean | undefined;
    get index(): Word | undefined;
    get value(): Word | ArrayValue;
    private resolveTarget;
    toJSON(): Assignment;
}
