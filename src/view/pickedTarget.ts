/**
 * Where a conversation picked in the chat's picker opens (#301): in another chat window when Ctrl/Cmd was held, here
 * otherwise. Picking the one already open here, or the entry for the unkept conversation, opens nothing.
 */
export function pickedTarget(picked: string, open: string, unkept: string, mod: boolean): "here" | "window" | "none" {
  if (picked === unkept) return "none";
  if (mod) return "window";
  return picked === open && picked !== "" ? "none" : "here";
}
