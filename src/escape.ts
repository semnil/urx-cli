// Escaping strings that come from outside the CLI (a device, Device Center) for
// display, so that their content cannot drive the terminal (P5, U6). JSON keeps
// the exact values; only human-readable output is escaped.

/** C0 controls, DEL and C1 controls: the characters a terminal acts on. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

/** `text` with each control character written as `\xHH`; everything else unchanged. */
export const escapeForDisplay = (text: string): string =>
  text.replace(CONTROL, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
