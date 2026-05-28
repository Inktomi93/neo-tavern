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
}

export type MacroHandler = (args: string[], ctx: MacroContext, children?: MacroAST) => string;

export interface MacroRegistry {
  register(name: string, handler: MacroHandler): void;
  get(name: string): MacroHandler | undefined;
}
