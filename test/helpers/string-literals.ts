export interface Literal {
  kind: "string" | "template";
  /** Offsets of the literal's text in the source (quotes excluded for strings; for templates, the part between delimiters). */
  start: number;
  end: number;
  raw: string;
  line: number;
}

/**
 * The string literals and template-literal parts in TypeScript source, with comments and regex literals skipped.
 * A small lexer (not a parser): enough to tell code from strings for a text scan.
 */
export function stringLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  const stack: number[] = []; // brace depth at each open `${`
  let depth = 0;
  let i = 0;
  let line = 1;
  let prev = ""; // previous significant character, to tell a regex from a division
  const lineAt = (pos: number) => src.slice(0, pos).split("\n").length;

  const readTemplate = (from: number): void => {
    let j = from;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "\\") j++;
      else if (c === "`") {
        out.push({ kind: "template", start: from, end: j, raw: src.slice(from, j), line: lineAt(from) });
        i = j + 1;
        prev = "`";
        return;
      } else if (c === "$" && src[j + 1] === "{") {
        out.push({ kind: "template", start: from, end: j, raw: src.slice(from, j), line: lineAt(from) });
        stack.push(depth);
        depth++;
        i = j + 2;
        prev = "{";
        return;
      }
    }
    i = src.length;
  };

  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "\n") {
      line++;
      i++;
    } else if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? src.length : e + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out.push({ kind: "string", start: i + 1, end: j, raw: src.slice(i + 1, j), line: lineAt(i) });
      i = j + 1;
      prev = c;
    } else if (c === "`") {
      readTemplate(i + 1);
    } else if (c === "/" && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(prev)) {
      // regex literal
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      i = j + 1;
      prev = "/";
    } else if (c === "{") {
      depth++;
      i++;
      prev = c;
    } else if (c === "}") {
      depth--;
      i++;
      prev = c;
      if (stack.length && stack[stack.length - 1] === depth) {
        stack.pop();
        readTemplate(i);
      }
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  void line;
  return out;
}
