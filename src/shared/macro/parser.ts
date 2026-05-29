import type { MacroAST, MacroBlockNode, MacroNode } from "./types";

type FlatNode =
  | MacroNode
  | { type: "blockOpen"; name: string; args: string[] }
  | { type: "blockClose"; name: string };

export function parseMacros(text: string): MacroAST {
  const flatAst: FlatNode[] = [];
  let pos = 0;

  while (pos < text.length) {
    const nextMacroStart = text.indexOf("{{", pos);
    if (nextMacroStart === -1) {
      flatAst.push({ type: "text", value: text.slice(pos) });
      break;
    }

    if (nextMacroStart > pos) {
      flatAst.push({ type: "text", value: text.slice(pos, nextMacroStart) });
    }

    pos = nextMacroStart + 2;

    // Comment macro: {{// … }} — consumed whole, emits nothing. Scanned depth-aware (mirroring the
    // arg reader) so a nested {{…}} inside the comment doesn't close it early.
    if (text.startsWith("//", pos)) {
      let cDepth = 1;
      let j = pos + 2;
      for (; j < text.length; j++) {
        if (text.startsWith("{{", j)) {
          cDepth++;
          j++;
        } else if (text.startsWith("}}", j)) {
          cDepth--;
          if (cDepth === 0) break;
          j++;
        }
      }
      if (j >= text.length) {
        // Unclosed comment → preserve from the `{{` as literal text (matches unclosed-macro handling).
        flatAst.push({ type: "text", value: text.slice(nextMacroStart) });
        break;
      }
      pos = j + 2; // skip the closing }}
      continue;
    }

    let isBlock = false;
    let isBlockClose = false;

    if (text[pos] === "#") {
      isBlock = true;
      pos++;
    } else if (text[pos] === "/") {
      isBlockClose = true;
      pos++;
    }

    let prefix = "{{";
    if (isBlock) prefix = "{{#";
    else if (isBlockClose) prefix = "{{/";

    // Read identifier
    const idMatch = text.slice(pos).match(/^[a-zA-Z][\w-_]*/);
    if (!idMatch) {
      // Invalid macro, treat as text
      flatAst.push({ type: "text", value: prefix });
      continue;
    }

    const name = idMatch[0];
    pos += name.length;

    // Read arguments tracking depth of {{ and }}
    let depth = 1;
    let argStr = "";
    let endMacroPos = -1;

    for (let i = pos; i < text.length; i++) {
      if (text.startsWith("{{", i)) {
        depth++;
        argStr += "{{";
        i++; // skip next {
      } else if (text.startsWith("}}", i)) {
        depth--;
        if (depth === 0) {
          endMacroPos = i;
          break;
        }
        argStr += "}}";
        i++; // skip next }
      } else {
        argStr += text[i];
      }
    }

    if (endMacroPos === -1) {
      // Unclosed macro
      let unclosedPrefix = "{{";
      if (isBlock) unclosedPrefix = "{{#";
      else if (isBlockClose) unclosedPrefix = "{{/";
      flatAst.push({ type: "text", value: unclosedPrefix + name + argStr });
      break;
    }

    pos = endMacroPos + 2; // skip }}

    const args = parseArgs(argStr);

    if (isBlockClose) {
      flatAst.push({ type: "blockClose", name });
    } else if (isBlock) {
      flatAst.push({ type: "blockOpen", name, args });
    } else {
      flatAst.push({ type: "macro", name, args });
    }
  }

  return buildBlocks(flatAst);
}

function splitArgs(argStr: string, separator: string): string[] {
  const args: string[] = [];
  let currentArg = "";
  let depth = 0;

  for (let i = 0; i < argStr.length; i++) {
    if (argStr.startsWith("{{", i)) {
      depth++;
      currentArg += "{{";
      i++;
    } else if (argStr.startsWith("}}", i)) {
      if (depth > 0) depth--;
      currentArg += "}}";
      i++;
    } else if (depth === 0 && argStr.startsWith(separator, i)) {
      args.push(currentArg.trim());
      currentArg = "";
      i += separator.length - 1;
    } else {
      currentArg += argStr[i];
    }
  }

  if (currentArg.trim().length > 0) {
    args.push(currentArg.trim());
  }

  return args;
}

function parseArgs(argStr: string): string[] {
  const trimmedArgStr = argStr.trim();
  if (trimmedArgStr.length === 0) return [];

  // ST supports :: and :
  if (trimmedArgStr.startsWith("::")) {
    return splitArgs(trimmedArgStr.slice(2), "::");
  } else if (trimmedArgStr.startsWith(":")) {
    // If it uses single colon, ST typically comma-separates the rest
    return splitArgs(trimmedArgStr.slice(1), ",");
  } else {
    // Some legacy macros use space or =
    return [trimmedArgStr.trim()];
  }
}

function buildBlocks(flatAst: FlatNode[]): MacroAST {
  const root: MacroAST = [];
  const stack: { node: MacroNode | null; children: MacroAST }[] = [{ node: null, children: root }];

  for (const node of flatAst) {
    if (node.type === "blockOpen") {
      const blockNode: MacroBlockNode = {
        type: "block",
        name: node.name,
        args: node.args,
        children: [],
      };
      stack[stack.length - 1]?.children.push(blockNode);
      stack.push({ node: blockNode, children: blockNode.children });
    } else if (node.type === "blockClose") {
      // Find matching block
      let matched = false;
      for (let i = stack.length - 1; i >= 1; i--) {
        const stackNode = stack[i]?.node;
        if (stackNode && stackNode.type === "block" && stackNode.name === node.name) {
          // Close everything down to here
          stack.length = i;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Unmatched close, emit as text
        stack[stack.length - 1]?.children.push({ type: "text", value: `{{/${node.name}}}` });
      }
    } else {
      stack[stack.length - 1]?.children.push(node as MacroNode);
    }
  }

  return root;
}
