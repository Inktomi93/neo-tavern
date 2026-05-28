export type MacroAST = MacroNode[];

export type MacroNode = TextNode | MacroCallNode | MacroBlockNode;

export interface TextNode {
  type: "text";
  value: string;
}

export interface MacroCallNode {
  type: "macro";
  name: string;
  args: string[];
}

export interface MacroBlockNode {
  type: "block";
  name: string;
  args: string[];
  children: MacroAST;
}

export interface MacroContext {
  char: string;
  user: string;
  persona: string;
  scenario: string;
  // Allows extensions (like Regex) or future features to pass arbitrary runtime state
  env: Record<string, unknown>;
  // Recursively evaluate strings (e.g. for nested macros in args)
  evaluateString: (text: string) => string;
  // Evaluate an AST directly (e.g. for block macro children)
  evaluateAST: (ast: MacroAST) => string;
  // Optional post-processing hook for macro values (e.g. escaping regex chars)
  postProcess?: (val: string) => string;
  // Optional warning sink. Server layer injects getLog().warn; tests/client can leave undefined.
  // Kept as a plain callback (not a Logger import) so shared/ stays isolated from server/.
  onWarn?: (msg: string, err?: unknown) => void;
}

export type MacroHandler = (args: string[], ctx: MacroContext, children?: MacroAST) => string;

export interface MacroRegistry {
  register(name: string, handler: MacroHandler): void;
  get(name: string): MacroHandler | undefined;
}
