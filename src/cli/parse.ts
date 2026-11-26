// Argument grammar (C1, C4, C5, C10, H3, H4, H5): the complete command path comes
// first, then named arguments in any order, and a command's one positional
// argument anywhere among them. Parsing reads only the tokens and the command
// table; it never connects, reads a file or inspects the environment. Messages
// name only canonical command paths and known argument names, never a token
// the user typed (P4).

import { acceptsArgument, COMMANDS, type CommandSpec, type Mode } from "./commands.js";

export type ParseResult =
  | { readonly kind: "help"; readonly path: readonly string[] }
  | { readonly kind: "version" }
  | {
      readonly kind: "command";
      readonly command: CommandSpec;
      /** Flags map to `true`; value arguments to their string, which may be empty. */
      readonly arguments: ReadonlyMap<string, string | true>;
      readonly positional: string | null;
    }
  | { readonly kind: "error"; readonly message: string };

const isOption = (token: string) => token.startsWith("--");

/** The command paths and the groups (proper prefixes) they form, each keyed by its words. */
const key = (path: readonly string[]) => path.join(" ");
const COMMAND_BY_PATH = new Map(COMMANDS.map((command) => [key(command.path), command]));
const GROUPS = new Set(COMMANDS.flatMap((command) => command.path.slice(0, -1).map((_, end) => key(command.path.slice(0, end + 1)))));

/** Whether a path names a command or a group of commands. */
export function isKnownPath(path: readonly string[]): boolean {
  return COMMAND_BY_PATH.has(key(path)) || GROUPS.has(key(path));
}

/** The prefix shown before a command path in messages and usage lines. */
export const commandPrefix = (mode: Mode) => (mode === "one-shot" ? "urx " : "");

const ONLY_IN: Record<Mode, string> = {
  "one-shot": "from the shell",
  console: "in the console",
  "command-file": "in a command file",
};

export function parse(tokens: readonly string[], mode: Mode): ParseResult {
  const prefix = commandPrefix(mode);
  const error = (message: string): ParseResult => ({ kind: "error", message });
  const helpHint = (path: readonly string[]) => `See \`${prefix}${[...path, "--help"].join(" ")}\`.`;

  if (tokens.length === 0) return { kind: "help", path: [] };
  const [first] = tokens as [string, ...string[]];
  if (first === "--version" || first === "--help") {
    if (mode === "command-file") return error(`${first} is not accepted in a command file.`);
    if (tokens.length > 1) return error(`${first} takes no other arguments.`);
    return first === "--version" ? { kind: "version" } : { kind: "help", path: [] };
  }
  if (isOption(first)) return error(`Arguments go after the command. ${helpHint([])}`);

  // The command path: words up to the first option, or up to a complete command.
  const path: string[] = [];
  let index = 0;
  while (index < tokens.length && !COMMAND_BY_PATH.has(key(path))) {
    const token = tokens[index] as string;
    if (isOption(token)) break;
    const next = [...path, token];
    if (!isKnownPath(next)) {
      return error(`${path.length === 0 ? "Unknown command" : `Unknown subcommand of \`${prefix}${path.join(" ")}\``}. ${helpHint(path)}`);
    }
    path.push(token);
    index += 1;
  }
  const rest = tokens.slice(index);
  const command = COMMAND_BY_PATH.get(key(path));

  if (rest.length === 1 && rest[0] === "--help") {
    if (mode === "command-file") return error("--help is not accepted in a command file.");
    return { kind: "help", path };
  }
  if (command === undefined) {
    if (rest.length === 0) return error(`\`${prefix}${path.join(" ")}\` needs a subcommand. ${helpHint(path)}`);
    return error(`Arguments go after the complete command; \`${prefix}${path.join(" ")}\` needs a subcommand first. ${helpHint(path)}`);
  }
  if (!command.modes.includes(mode)) {
    const where = command.modes.map((m) => ONLY_IN[m]).join(" or ");
    return error(`\`${path.join(" ")}\` is available only ${where}.`);
  }

  const values = new Map<string, string | true>();
  let positional: string | null = null;
  for (let at = 0; at < rest.length; at += 1) {
    const token = rest[at] as string;
    if (!isOption(token)) {
      if (command.positional === undefined || positional !== null) {
        return error(`Unexpected positional argument for \`${prefix}${path.join(" ")}\`. ${helpHint(path)}`);
      }
      positional = token;
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals < 0 ? token.slice(2) : token.slice(2, equals);
    if (name === "help") return error(`--help cannot be combined with other arguments. ${helpHint(path)}`);
    const spec = command.arguments.find((argument) => argument.name === name);
    if (spec === undefined || !acceptsArgument(spec, mode)) {
      return error(`Unknown argument for \`${prefix}${path.join(" ")}\`. ${helpHint(path)}`);
    }
    if (values.has(name)) return error(`--${name} is given more than once.`);
    if (spec.kind === "flag") {
      if (equals >= 0) return error(`--${name} takes no value.`);
      values.set(name, true);
      continue;
    }
    if (equals >= 0) {
      values.set(name, token.slice(equals + 1));
      continue;
    }
    const value = rest[at + 1];
    if (value === undefined || isOption(value)) {
      return error(`--${name} needs a value. A value that starts with -- is written --${name}=<value>.`);
    }
    values.set(name, value);
    at += 1;
  }

  for (const spec of command.arguments) {
    if (spec.required === true && acceptsArgument(spec, mode) && !values.has(spec.name)) {
      return error(`\`${prefix}${path.join(" ")}\` needs --${spec.name}. ${helpHint(path)}`);
    }
  }
  if (command.positional !== undefined && positional === null) {
    return error(`\`${prefix}${path.join(" ")}\` needs ${command.positional.name}. ${helpHint(path)}`);
  }
  return { kind: "command", command, arguments: values, positional };
}
