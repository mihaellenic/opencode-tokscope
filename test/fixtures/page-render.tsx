import { testRender } from "@opentui/solid"
import { TokscopePage } from "../../src/page/tokscope"
import type { Plugin } from "@opencode/plugin/tui"
import type { HistoryService } from "../../src/history/service"

export const renderPage = (context: Plugin.Context, service: HistoryService, width: number, height: number) =>
  testRender(() => <TokscopePage context={context} service={service} onClose={() => {}} />, { width, height })
