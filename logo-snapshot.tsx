// Throwaway: renders the current TUI to stdout so the logo change is visible
// without running the interactive dashboard. Delete after use.
import { render } from "ink-testing-library";
import React from "react";
import { App } from "./src/tui.tsx";
const { lastFrame } = render(<App />);
console.log(lastFrame());
