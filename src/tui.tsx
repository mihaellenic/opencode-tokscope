import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { createRepository } from "./history/durable"
import { createPluginDurableStore } from "./history/plugin-storage"
import { createHistoryFileLogger } from "./history/log-file"
import { createHistoryService } from "./history/service"
import { TokscopePage } from "./page/tokscope"
import { createWidgetStore } from "./sidebar/store"
import { TokscopeSidebar } from "./sidebar/widget"

export default Plugin.define({
  id: "tokscope",
  setup(context) {
    const [previous, setPrevious] = createSignal({ ...context.ui.router.current() })

    const openTokscope = () => {
      const current = context.ui.router.current()
      if (current.type === "plugin" && current.name === "tokscope") return
      setPrevious({ ...current })
      context.ui.dialog.clear()
      context.ui.router.navigate({ type: "plugin", name: "tokscope" })
    }

    // One durable namespace and one acquisition pipeline for every server and view. The hold lives
    // for the plugin, so the cache keeps catching up while OpenCode runs even with no page open.
    let unsubscribeEvents: (() => void) | undefined
    const historyLogger = createHistoryFileLogger()
    const service = createHistoryService({
      client: context.client,
      repository: createRepository(createPluginDurableStore(context.storage)),
      subscribeEvents: (handler) => {
        unsubscribeEvents = context.data.listen(({ details }) =>
          handler({ type: details.type, data: details.data as { sessionID?: string } | undefined }),
        )
        return unsubscribeEvents
      },
      setTimer: (callback, ms) => {
        const id = setInterval(callback, ms)
        return () => clearInterval(id)
      },
      delay: (callback, ms) => {
        const id = setTimeout(callback, ms)
        return () => clearTimeout(id)
      },
      now: () => Date.now(),
      log: historyLogger.log,
    })
    const release = service.hold()
    // The sidebar reads the same service and holds it while mounted, so both views share one cache.
    const store = createWidgetStore(service)

    context.ui.router.register({
      name: "tokscope",
      render: () => (
        <TokscopePage
          context={context}
          service={service}
          onClose={() => context.ui.router.navigate(previous())}
        />
      ),
    })

    context.ui.slot({
      append: "sidebar.content",
      render: () => <TokscopeSidebar context={context} store={store} open={openTokscope} />,
    })

    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "tokscope.open",
              title: "Tokscope",
              group: "System",
              slash: { name: "tokscope" },
              palette: true,
              run: openTokscope,
            },
            {
              id: "tokscope.resetHistory",
              title: "Tokscope: reset history cache",
              group: "System",
              palette: true,
              run: async () => {
                const confirmed = await context.ui.dialog.confirm({
                  title: "Reset Tokscope history cache",
                  message: "Delete the shared Tokscope history cache and rebuild it from the server?",
                  label: { confirm: "Reset", cancel: "Cancel" },
                })
                if (confirmed === true) await service.reset()
              },
            },
          ],
        }))
        return null
      },
    })

    return () => {
      unsubscribeEvents?.()
      release()
    }
  },
})
