// Help text (H1, H2, H4), generated from the command table alone: it needs no
// connection and lists exactly what the parser accepts in the given mode.

import { acceptsArgument, COMMANDS, type ArgumentSpec, type CommandSpec, type Mode } from "./commands.js";
import { commandPrefix } from "./parse.js";

const ONLY_IN: Record<Mode, string> = {
  "one-shot": "shell only",
  console: "console only",
  "command-file": "command file only",
};

/** Help for the root (`path` empty), a group of commands, or one command. */
export function renderHelp(path: readonly string[], mode: Mode): string {
  const exact = COMMANDS.find((command) => sameWords(command.path, path));
  return exact === undefined ? renderGroup(path, mode) : renderCommand(exact, mode);
}

function renderGroup(path: readonly string[], mode: Mode): string {
  const prefix = commandPrefix(mode);
  const members = COMMANDS.filter((command) => sameWords(command.path.slice(0, path.length), path));
  const rows = members.map((command) => {
    const note = command.modes.includes(mode) ? "" : ` (${command.modes.map((m) => ONLY_IN[m]).join(", ")})`;
    return [command.path.join(" "), `${command.summary}${note}`] as const;
  });
  const lines = [`Usage: ${prefix}${[...path, "<command>"].join(" ")} [arguments]`, "", "Commands:", ...table(rows), ""];
  lines.push(`Run \`${prefix}<command> --help\` for the arguments of a command.`);
  if (path.length === 0 && mode !== "command-file") lines.push(`\`${prefix}--version\` shows the build information.`);
  return `${lines.join("\n")}\n`;
}

function renderCommand(command: CommandSpec, mode: Mode): string {
  const prefix = commandPrefix(mode);
  const accepted = command.arguments.filter((argument) => acceptsArgument(argument, mode));
  const usage = [
    `${prefix}${command.path.join(" ")}`,
    ...(command.positional === undefined ? [] : [command.positional.name]),
    ...accepted.map((argument) => (argument.required === true ? written(argument) : `[${written(argument)}]`)),
  ].join(" ");
  const lines = [`Usage: ${usage}`, "", command.summary + "."];
  if (!command.modes.includes(mode)) lines.push(`Available ${command.modes.map((m) => ONLY_IN[m]).join(", ")}.`);
  const rows = [
    ...(command.positional === undefined ? [] : [[command.positional.name, command.positional.description] as const]),
    ...accepted.map((argument) => [written(argument), argument.description] as const),
  ];
  if (rows.length > 0) lines.push("", "Arguments:", ...table(rows));
  return `${lines.join("\n")}\n`;
}

const written = (argument: ArgumentSpec) =>
  argument.kind === "flag" ? `--${argument.name}` : `--${argument.name} ${argument.placeholder ?? "<value>"}`;

function table(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

const sameWords = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((word, i) => word === b[i]);
