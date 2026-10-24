import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
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

    const store = createWidgetStore({
      client: context.client,
      onEvent: (handler) => context.data.on("session.step.ended", handler),
      setTimer: (callback, ms) => {
        const id = setInterval(callback, ms)
        return () => clearInterval(id)
      },
      now: () => Date.now(),
    })

    context.ui.router.register({
      name: "tokscope",
      render: () => <TokscopePage context={context} onClose={() => context.ui.router.navigate(previous())} />,
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
          ],
        }))
        return null
      },
    })
  },
})
