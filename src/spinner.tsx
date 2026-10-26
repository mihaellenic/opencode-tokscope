import type { Plugin } from "@opencode/plugin/tui"
import { createSpinnerTicker } from "./spinner-ticker"

/** The only refresh indicator: an empty view still acquiring or retrying has nothing else to show. */
export function Spinner(props: { context: Plugin.Context }) {
  const frame = createSpinnerTicker()
  return <text fg={props.context.theme.text.muted}>{frame()}</text>
}
