/**
 * Python's `fnmatch.fnmatch` for the patterns `find_notes` takes: `*`, `?`, `[seq]`, `[!seq]`. Both sides are
 * lower-cased by the caller, as the Python tool does, so case never decides.
 */

export function fnmatch(name: string, pattern: string): boolean {
  return translate(pattern).test(name);
}

function translate(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      out += "[\\s\\S]*";
    } else if (c === "?") {
      out += "[\\s\\S]";
    } else if (c === "[") {
      let j = i + 1;
      if (pattern[j] === "!") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j >= pattern.length) {
        out += "\\[";  // no closing bracket: a literal "[", as in Python
      } else {
        let body = pattern.slice(i + 1, j).replace(/\\/g, "\\\\");
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        else if (body.startsWith("^")) body = `\\${body}`;
        out += `[${body}]`;
        i = j;
      }
    } else {
      out += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
    }
  }
  return new RegExp(`^(?:${out})$`);
}
