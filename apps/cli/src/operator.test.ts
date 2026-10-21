import { describe, expect, it } from "vitest";
import { operatorCommand } from "./operator.js";

describe("operatorCommand", () => {
  it("finds the server's command as the first argument that isn't an option", () => {
    expect(operatorCommand(["admin", "tenant", "list"])).toEqual({ value: "admin", index: 0 });
    expect(operatorCommand(["--data-dir", "/x", "init", "--solo"])).toEqual({
      value: "init",
      index: 2,
    });
    expect(operatorCommand(["--data-dir=/x", "serve"])).toEqual({ value: "serve", index: 1 });
    // A directory named admin; a command that isn't the server's; nothing.
    expect(operatorCommand(["--data-dir", "admin"])).toBeNull();
    expect(operatorCommand(["manifest", "admin"])).toBeNull();
    expect(operatorCommand([])).toBeNull();
  });
});
