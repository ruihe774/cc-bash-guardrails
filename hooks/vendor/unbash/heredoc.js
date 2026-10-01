export class HereDocBodyImpl {
    static _resolveParts;
    type = "HereDocBody";
    pos;
    end;
    text = "";
    #source;
    #depth;
    #parts;
    constructor(source, pos, quoted, depth) {
        this.pos = pos;
        this.end = pos;
        this.#source = source;
        this.#depth = depth;
        this.#parts = quoted ? undefined : null;
    }
    get parts() {
        if (this.#parts === null)
            this.#parts = HereDocBodyImpl._resolveParts(this.#source, this, this.#depth);
        return this.#parts;
    }
    toJSON() {
        return { type: this.type, pos: this.pos, end: this.end, text: this.text, parts: this.parts };
    }
}
