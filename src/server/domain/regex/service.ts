import { processMacros } from "../../../shared/macro/index";
import type { MacroContext } from "../../../shared/macro/types";
import type { RegexPlacement, RegexScript } from "../../../shared/regex";

export interface RegexService {
  executeScripts(
    text: string,
    scripts: RegexScript[],
    placement: RegexPlacement,
    ctx: MacroContext,
  ): string;
}

export function createRegexService(): RegexService {
  return {
    executeScripts(
      text: string,
      scripts: RegexScript[],
      placement: RegexPlacement,
      ctx: MacroContext,
    ): string {
      let result = text;

      for (const script of scripts) {
        if (!script.enabled) continue;
        if (!script.placement.includes(placement)) continue;

        try {
          // SillyTavern usually appends 'g' to findRegex unless 'i' or 'm' etc are provided,
          // but many users write just the pattern.
          // In ST regex engine: `new RegExp(script.findRegex, 'gm')` or similar.
          // We will use 'g' by default unless it looks like a regex literal with flags (e.g. /pattern/flags)

          let pattern = script.findRegex;
          let flags = "gm"; // ST default for raw strings

          if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
            const lastSlash = pattern.lastIndexOf("/");
            flags = pattern.substring(lastSlash + 1);
            pattern = pattern.substring(1, lastSlash);
            if (!flags.includes("g")) flags += "g"; // Always global for replacements
          }

          const regex = new RegExp(pattern, flags);

          result = result.replace(regex, (...args) => {
            // JS replace with regex passes:
            // arg0 = matched string
            // arg1..N = capture groups
            // argN+1 = offset
            // argN+2 = full string
            // We want to simulate ST's behavior:
            // The replacement string might have $1, $2, etc., OR macro syntax.

            // ST allows {{match}} to mean $0
            let replacement = script.replaceString.replace(/{{match}}/gi, "$0");

            replacement = replacement.replace(
              /\$(\d+)|\$<([^>]+)>/g,
              (_fullMatch, num, groupName) => {
                let matchText: string | undefined;

                if (num !== undefined) {
                  const index = parseInt(num, 10);
                  matchText = args[index];
                } else if (groupName !== undefined) {
                  const groups = args[args.length - 1];
                  if (groups && typeof groups === "object") {
                    matchText = (groups as Record<string, string>)[groupName];
                  }
                }

                return matchText ?? "";
              },
            );

            // 2. Then, run the resulting string through the Macro Engine
            return processMacros(replacement, ctx);
          });
        } catch (_err) {
          // If the regex is invalid, skip it rather than crashing the chat
          // TODO: Log the error using standard logging
        }
      }

      return result;
    },
  };
}
