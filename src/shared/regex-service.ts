import { processMacros } from "./macro/index";
import type { MacroContext } from "./macro/types";
import type { RegexPlacement, RegexScript } from "./regex";
import { SubstituteFindRegex } from "./regex";

function sanitizeRegexMacro(x: string): string {
  // FIXED: Restored the proper regex syntax and added curly braces around the switch block
  return x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (s) => {
    switch (s) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      case "\v":
        return "\\v";
      case "\f":
        return "\\f";
      case "\0":
        return "\\0";
      default:
        return `\\${s}`;
    }
  });
}

function filterString(rawString: string, trimStrings: string[], ctx: MacroContext): string {
  let finalString = rawString;
  for (const trimString of trimStrings) {
    if (!trimString) continue;
    const subTrimString = processMacros(trimString, ctx);
    if (subTrimString) {
      finalString = finalString.split(subTrimString).join("");
    }
  }
  return finalString;
}

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
      // FIXED: Changed const to let so we can modify it
      let result = text;

      for (const script of scripts) {
        if (!script.enabled) continue;
        if (!script.placement.includes(placement)) continue;

        try {
          let pattern = script.findRegex;

          if (script.substituteRegex === SubstituteFindRegex.raw) {
            pattern = processMacros(pattern, ctx);
          } else if (script.substituteRegex === SubstituteFindRegex.escaped) {
            pattern = processMacros(pattern, { ...ctx, postProcess: sanitizeRegexMacro });
          }

          let flags = "gm";

          if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
            const lastSlash = pattern.lastIndexOf("/");
            flags = pattern.substring(lastSlash + 1);
            pattern = pattern.substring(1, lastSlash);
            if (!flags.includes("g")) flags += "g"; // Always global for replacements
          }

          const regex = new RegExp(pattern, flags);

          result = result.replace(regex, (...args) => {
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

                if (!matchText) return "";

                if (script.trimStrings && script.trimStrings.length > 0) {
                  matchText = filterString(matchText, script.trimStrings, ctx);
                }

                return matchText;
              },
            );

            return processMacros(replacement, ctx);
          });
        } catch (_err) {
          // If the regex is invalid, skip it rather than crashing the chat
        }
      }

      return result;
    },
  };
}
