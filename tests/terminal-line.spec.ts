import { test, expect } from "@playwright/test";
import { currentLogicalLine } from "../src/utils/terminalBuffer";

// Minimal stand-in for xterm's buffer API
function fakeTerm(rows: { text: string; wrapped?: boolean }[], baseY: number, cursorY: number) {
  return {
    buffer: {
      active: {
        baseY, cursorY,
        getLine: (i: number) => rows[i] && ({
          isWrapped: !!rows[i].wrapped,
          translateToString: (trim?: boolean) => (trim ? rows[i].text.trimEnd() : rows[i].text),
        }),
      },
    },
  } as any;
}

test("reads the row under the cursor, not an old scrollback row (BUG-010)", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ text: `$ old-command-${i}` }));
  rows[22] = { text: "$ the-real-command   " };
  expect(currentLogicalLine(fakeTerm(rows, 20, 2))).toBe("$ the-real-command");
});

test("joins a soft-wrapped long command", () => {
  const rows = [{ text: "$ docker run --name very-long-" }, { text: "container-name nginx", wrapped: true }];
  expect(currentLogicalLine(fakeTerm(rows, 0, 1))).toBe("$ docker run --name very-long-container-name nginx");
});
